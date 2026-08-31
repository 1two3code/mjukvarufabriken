import { gateName } from '@mf/models'

import { tail } from './exec.ts'
import { licenceGate } from './gates/licence.ts'
import { totalTokens } from './types.ts'

import type { GateName, GateReport, NewJobEvent, NotifyPayload } from '@mf/models'
import type { GateInput, GateOutcome, OrchestratorPorts, TokenUsage } from './types.ts'

/** Gate order after the last merge: verify(lint+test) → acceptance-tests → review → licence → acceptance-check */
export const gateOrder: readonly GateName[] = gateName

export type RunGatesInput = Omit<GateInput, 'onUsage'> & {
	ports: OrchestratorPorts
	onUsage: (usage: TokenUsage) => void
	/** Awaited after every gate; a rejection is swallowed (the event sink is not fatal) */
	emit: (event: NewJobEvent) => Promise<void>
	/** True once the budget/kill switch has aborted the job; stops the chain right away */
	isAborted: () => boolean
	now?: () => number
}

export type RunGatesOutcome = {
	/** All green (and nothing was aborted) */
	ok: boolean
	reports: GateReport[]
	/** Names of the gates that were red (at most one — the chain stops at the first) */
	failed: GateName[]
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

/**
 * Runs the gates in order, one report per gate, and fails closed: the first red gate ends the
 * chain (later gates are not run), a port that throws counts as red, and an abort (budget, wall
 * clock, kill switch) stops everything without a report for the interrupted gate. Every gate's
 * usage flows into the job budget via `onUsage`.
 */
export const runGates = async ({
	ports,
	emit,
	isAborted,
	onUsage,
	now = Date.now,
	...input
}: RunGatesInput): Promise<RunGatesOutcome> => {
	const reports: GateReport[] = []
	for (const name of gateOrder) {
		if (isAborted()) break
		const startedAt = now()
		let gateTokens = 0
		const count = (usage: TokenUsage) => {
			gateTokens += totalTokens(usage)
			onUsage(usage)
		}
		let outcome: GateOutcome
		try {
			outcome = await gatePort(ports, name)({ ...input, onUsage: count })
		} catch (error) {
			outcome = {
				ok: false,
				tokens: gateTokens,
				summary: `gate crashed: ${(error as Error).message}`,
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
