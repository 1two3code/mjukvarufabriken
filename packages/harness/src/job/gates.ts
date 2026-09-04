import { gateName } from '@mf/models'

import {
	deliveryReserveTokens,
	gateAllowanceShare,
	gateChainReserveTokens,
	gateGuardMinBudgetTokens,
} from './budget.ts'
import { tail } from './exec.ts'
import { licenceGate } from './gates/licence.ts'
import { totalTokens } from './types.ts'

import type { GateName, GateReport, NewJobEvent, NotifyPayload } from '@mf/models'
import type { GateInput, GateOutcome, OrchestratorPorts, TokenUsage } from './types.ts'

/** Gate order after the last merge: verify(lint+test) → acceptance-tests → review → licence → acceptance-check */
export const gateOrder: readonly GateName[] = gateName

/**
 * What each gate costs as a share of the whole chain, measured on the delivered M-class job
 * 86fe268f (2026-09-03): acceptance-tests 1.08M, review 249k, acceptance-check 43k of 1.37M.
 * `verify` (lint + test) and `licence` (a denylist over the lockfile) call no model and are free.
 *
 * Used to price the gates that have NOT run yet, so the affordability floor shrinks as the chain
 * advances: a job with 300k left is rightly refused before acceptance-tests and rightly allowed
 * into review.
 */
export const gateCostShare: Record<GateName, number> = {
	verify: 0,
	'acceptance-tests': 0.79,
	review: 0.18,
	licence: 0,
	'acceptance-check': 0.03,
}

/** Budget-tokens the gates from `index` onward are expected to need */
const chainCostFrom = (index: number, chainReserve: number) =>
	chainReserve * gateOrder.slice(index).reduce((total, name) => total + gateCostShare[name], 0)

/**
 * Lets the gate chain see the job budget. Without one the gates run unmetered, exactly as they did
 * before — `runGates` is also used stand-alone by `gates-demo`, which has no job budget.
 */
export type GateBudget = {
	/** Budget-tokens the job has left right now */
	remaining: () => number
	/** Never spend the chain below this: a green build still has to pay for its delivery */
	reserve: number
	/** What the whole chain is expected to cost; `gateCostShare` prices each gate against it */
	chainReserve: number
	/** Most a single gate may spend before it is stopped and reported red */
	allowancePerGate: number
}

/**
 * The guard rails for one job's budget, or `undefined` for a budget too small for the measured
 * reserves to mean anything (`gateGuardMinBudgetTokens`) — such a job runs its gates unmetered,
 * exactly as every job did before the reserves existed.
 */
export const gateBudgetFor = (maxTokens: number): Omit<GateBudget, 'remaining'> | undefined =>
	maxTokens < gateGuardMinBudgetTokens
		? undefined
		: {
				reserve: deliveryReserveTokens,
				chainReserve: gateChainReserveTokens,
				allowancePerGate: maxTokens * gateAllowanceShare,
			}

export type RunGatesInput = Omit<GateInput, 'onUsage'> & {
	ports: OrchestratorPorts
	onUsage: (usage: TokenUsage) => void
	/** Awaited after every gate; a rejection is swallowed (the event sink is not fatal) */
	emit: (event: NewJobEvent) => Promise<void>
	/** True once the budget/kill switch has aborted the job; stops the chain right away */
	isAborted: () => boolean
	budget?: GateBudget
	now?: () => number
}

export type RunGatesOutcome = {
	/** All green (and nothing was aborted) */
	ok: boolean
	reports: GateReport[]
	/** Names of the gates that were red (at most one — the chain stops at the first) */
	failed: GateName[]
	/** Set when the chain stopped because the job could not pay for this gate, not because it failed */
	exhausted?: GateName
}

const gatePort = (
	ports: OrchestratorPorts,
	name: GateName
): ((input: GateInput) => Promise<GateOutcome>) => {
	switch (name) {
		case 'verify':
			return async ({ repoDir, signal }) => {
				const verification = await ports.verify({ repoDir, signal })
				return {
					ok: verification.ok,
					tokens: 0,
					summary: verification.ok ? 'lint + test green' : tail(verification.output, 40),
				}
			}
		case 'acceptance-tests':
			return ports.acceptanceTests
		case 'review':
			return ports.review
		case 'licence':
			return ports.licence ?? licenceGate
		case 'acceptance-check':
			return ports.acceptanceCheck
	}
}

/** `1_400_000` → `1.4M`, `374_000` → `374k` — keeps token counts readable in gate summaries */
const readable = (count: number) =>
	count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : `${Math.round(count / 1000)}k`

/**
 * Runs the gates in order, one report per gate, and fails closed: the first red gate ends the
 * chain (later gates are not run), a port that throws counts as red, and an abort (budget, wall
 * clock, kill switch) stops everything without a report for the interrupted gate. Every gate's
 * usage flows into the job budget via `onUsage`.
 *
 * With a `budget` the chain is also metered against it, which is how a job that has built its app
 * and then run out of money ends legibly rather than catastrophically (job d0339616, 2026-09-03):
 * a model gate the job cannot pay for is reported red WITHOUT being started, and one that runs away
 * is stopped at its allowance. Both leave the whole report set intact and the abort controller
 * untouched, so the job still emits its events and uploads its debug bundle. The free gates
 * (`verify`, `licence`) always run: they cost nothing and knowing whether lint + test are green is
 * exactly what tells you whether re-running with a bigger budget is worth it.
 */
export const runGates = async ({
	ports,
	emit,
	isAborted,
	onUsage,
	budget,
	now = Date.now,
	...input
}: RunGatesInput): Promise<RunGatesOutcome> => {
	const reports: GateReport[] = []
	for (const [index, name] of gateOrder.entries()) {
		if (isAborted()) break
		const startedAt = now()
		const affordable = budget ? budget.remaining() - budget.reserve : Number.POSITIVE_INFINITY
		const needed = budget ? chainCostFrom(index, budget.chainReserve) : 0
		if (gateCostShare[name] > 0 && affordable < needed) {
			const report: GateReport = {
				name,
				ok: false,
				startedAt: new Date(startedAt).toISOString(),
				durationMs: 0,
				tokens: 0,
				summary: `not run: ${readable(Math.max(0, affordable))} of budget left, the remaining gates need about ${readable(needed)}`,
			}
			reports.push(report)
			await emit({ type: 'gate', payload: report }).catch(() => {})
			return { ok: false, reports, failed: [name], exhausted: name }
		}
		const allowance = Math.min(affordable, budget?.allowancePerGate ?? Number.POSITIVE_INFINITY)
		// Aborts this gate alone when it crosses its allowance; the job's own signal is untouched,
		// so the chain ends with a report instead of taking the whole job down with it.
		const overrun = new AbortController()
		const signal = budget ? AbortSignal.any([input.signal, overrun.signal]) : input.signal
		let gateTokens = 0
		const count = (usage: TokenUsage) => {
			gateTokens += totalTokens(usage)
			onUsage(usage)
			if (gateTokens > allowance && !overrun.signal.aborted) overrun.abort()
		}
		let outcome: GateOutcome
		try {
			outcome = await gatePort(ports, name)({ ...input, signal, onUsage: count })
		} catch (error) {
			outcome = {
				ok: false,
				tokens: gateTokens,
				summary: `gate crashed: ${(error as Error).message}`,
			}
		}
		// Whatever the port made of the abort — a throw, or a hopeful `ok` — an overrun gate is red
		if (overrun.signal.aborted) {
			outcome = {
				ok: false,
				tokens: gateTokens,
				summary: `stopped at its token allowance (${readable(gateTokens)} of ${readable(allowance)})`,
			}
		}
		if (isAborted()) break
		const report: GateReport = {
			name,
			ok: outcome.ok,
			startedAt: new Date(startedAt).toISOString(),
			durationMs: Math.max(0, now() - startedAt),
			tokens: Math.max(gateTokens, outcome.tokens),
			summary: outcome.summary,
			details: outcome.details,
		}
		reports.push(report)
		await emit({ type: 'gate', payload: report }).catch(() => {})
		if (!outcome.ok) return { ok: false, reports, failed: [name] }
	}
	return { ok: !isAborted(), reports, failed: [] }
}

/** Reason string for a job that failed its gates */
export const gatesFailedReason = (reports: GateReport[]) => {
	const red = reports.filter(report => !report.ok)
	const lines = red.map(report => `${report.name}: ${report.summary}`)
	return `${red.length} gate(s) failed: ${red.map(report => report.name).join(', ')}\n${lines.join('\n')}`
}

/** The `notify` payload sent to the admins when a job does not deliver */
export const failureNotification = (
	jobId: string,
	status: 'failed' | 'killed',
	reason: string | undefined,
	reports: GateReport[]
): NotifyPayload => {
	const gates = reports.length
		? reports
				.map(
					report =>
						`- ${report.name}: ${report.ok ? 'ok' : 'FAILED'} (${report.tokens} tokens, ${Math.round(report.durationMs / 1000)} s)`
				)
				.join('\n')
		: '- no gate ran'
	return {
		to: 'admins',
		subject: `Build job ${jobId} ${status}`,
		text: `Job ${jobId} ended with status ${status}.\n\nReason:\n${reason ?? '-'}\n\nGates:\n${gates}`,
		// Lets the api tell this mail apart from other notify events (delivery degradations stay
		// unmarked): it holds `job-failed` mails for a job it is about to auto-retry.
		...(status === 'failed' ? { kind: 'job-failed' as const } : {}),
	}
}
