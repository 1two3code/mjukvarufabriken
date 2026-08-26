/**
 * Runs ONLY the M4 gates (verify → acceptance-tests → review → acceptance-check) on an
 * already-built customer repo, against the live Agent SDK. For the main session to exercise the
 * gates on a Fargate/local build without paying for a whole job again.
 *
 *   npm run gates:demo -- --repo /work/repo --spec spec.json [--seed <commit>] [--waive <id>,...]
 *   npm run gates:demo -- --repo /work/repo --job <json with { spec, gateWaivers? }>
 *
 * Reads the root .env (ANTHROPIC_API_KEY, WORKER_MODEL). Prints one GateReport per gate and
 * exits 0 only when every gate is green. Exits 0 with "skipped" when the key is missing.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { SpecSchema } from '@mf/models'

import { BudgetTracker, createLivePorts, runGates } from '#job/index.ts'

const { values } = parseArgs({
	options: {
		repo: { type: 'string' },
		spec: { type: 'string' },
		job: { type: 'string' },
		seed: { type: 'string' },
		waive: { type: 'string' },
		'max-tokens': { type: 'string', default: '3000000' },
	},
})

if (!values.repo || (!values.spec && !values.job)) {
	console.error(
		'usage: gates-demo --repo <dir> (--spec <spec.json> | --job <job.json>) [--seed <commit>] [--waive a.ts:1,b.ts:2]'
	)
	process.exit(64)
}
if (!process.env.ANTHROPIC_API_KEY) {
	console.log('skipped: ANTHROPIC_API_KEY not set')
	process.exit(0)
}

const readJson = async (path: string) =>
	JSON.parse(await readFile(resolve(path), 'utf8')) as unknown
const jobJson = values.job
	? ((await readJson(values.job)) as { spec: unknown; gateWaivers?: string[] })
	: { spec: await readJson(values.spec!) }
const spec = SpecSchema.parse(jobJson.spec)
const waivers = [
	...(jobJson.gateWaivers ?? []),
	...(values.waive?.split(',').filter(Boolean) ?? []),
]
const repoDir = resolve(values.repo)

// The planner client is never used here; a stub keeps createLivePorts happy
const ports = createLivePorts({
	client: {
		messages: {
			create: async () => {
				throw new Error('gates-demo does not plan')
			},
		},
	} as never,
})
const budget = new BudgetTracker({
	maxTokens: Number(values['max-tokens']),
	maxDurationMinutes: 180,
	maxWorkers: 1,
})

console.log(
	`repo: ${repoDir}\nseed: ${values.seed ?? '(root commit)'}\nwaivers: ${waivers.join(', ') || '-'}\n`
)
const startedAt = Date.now()
// The orchestrator polls the wall clock from its own interval; stand-alone we do it here
const poll = setInterval(() => budget.checkDuration(), 10_000)
const outcome = await runGates({
	spec,
	repoDir,
	seedCommit: values.seed,
	waivers,
	signal: budget.signal,
	onUsage: usage => budget.add(usage),
	ports,
	emit: async event => {
		const report = event.payload as {
			name: string
			ok: boolean
			tokens: number
			durationMs: number
			summary: string
		}
		console.log(
			`\n=== gate ${report.name}: ${report.ok ? 'OK' : 'FAILED'} (${report.tokens} tokens, ${Math.round(report.durationMs / 1000)} s)\n${report.summary}`
		)
	},
	isAborted: () => budget.aborted,
})

clearInterval(poll)
console.log('\n=== reports')
console.log(JSON.stringify(outcome.reports, null, 2))
console.log(
	`\n${outcome.ok ? 'ALL GATES GREEN' : `FAILED: ${outcome.failed.join(', ') || budget.reason}`} — ${budget.used} budget-tokens, ${Math.round((Date.now() - startedAt) / 1000)} s`
)
process.exit(outcome.ok ? 0 : 1)
