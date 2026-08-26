/**
 * Build-job entrypoint (one container = one job). Reads `JOB_ID`, loads the job + frozen spec
 * through a `JobReporter` (the api's per-job endpoint on Fargate, Postgres for
 * `npm run job:dev`), seeds the customer repo from the template, runs the `@mf/harness`
 * orchestrator and streams status / tokens / events back the same way.
 */
import Anthropic from '@anthropic-ai/sdk'
import { createLivePorts, exec, runJob } from '@mf/harness'

import { loadConfig } from '#/config.ts'
import { gitIdentity, seedRepo } from '#/repo.ts'
import { createApiReporter, createDbReporter } from '#/reporter.ts'

import type { NewJobEvent } from '@mf/models'
import type { JobReporter } from '#/reporter.ts'

const log = (message: string, extra?: Record<string, unknown>) =>
	console.log(JSON.stringify({ time: new Date().toISOString(), message, ...extra }))

const config = await loadConfig(process.argv.slice(2))
// The worker sessions and the repo's own scripts inherit the environment (minus what
// @mf/harness' sandboxEnv strips); the report token and the database are only needed here.
for (const key of [
	'JOB_TOKEN',
	'DATABASE_URL',
	'DATABASE_SECRET_ARN',
	'ANTHROPIC_API_KEY_SECRET_ARN',
]) {
	delete process.env[key]
}
process.env.ANTHROPIC_API_KEY = config.anthropicApiKey
Object.assign(process.env, gitIdentity)

const { jobId } = config
const reporter: JobReporter =
	config.report.mode === 'api'
		? createApiReporter({ apiUrl: config.report.apiUrl, jobId, token: config.report.token })
		: await createDbReporter(config.report.databaseUrl, jobId)
log('reporting via ' + config.report.mode, { jobId })

const job = await reporter.load()
if (!job) {
	log('job not found', { jobId })
	await reporter.close()
	process.exit(2)
}
if (job.status !== 'queued') {
	log('job is not queued, refusing to run', { jobId, status: job.status })
	await reporter.close()
	process.exit(3)
}

const emit = async (event: NewJobEvent) => {
	log(`event ${event.type}`, { jobId, ...event.payload })
	await reporter.emit(event)
}

// Set when a status write is refused because the api already flipped the row to `killed`;
// the orchestrator's poll picks it up without waiting for the next round trip.
let killedByApi = false

/** Status write that respects the kill switch: `killed` back means the row is terminal */
const setStatus = async (update: Parameters<JobReporter['update']>[0]) => {
	const result = await reporter.update(update)
	if (result.killed) killedByApi = true
	return result
}

let phaseStatus: 'planning' | 'building' | 'verifying' = 'planning'
const trackPhase = async (event: NewJobEvent) => {
	const next =
		event.type === 'planned'
			? 'building'
			: event.type === 'verify' || event.type === 'gate'
				? 'verifying'
				: undefined
	if (next && next !== phaseStatus) {
		phaseStatus = next
		await setStatus({ status: next })
	}
}

/** Any crash after the row went active must leave a terminal status behind, never a stuck job */
const fail = async (reason: string) => {
	log('job crashed', { jobId, reason })
	await reporter.emit({ type: 'failed', payload: { reason } }).catch(() => {})
	await setStatus({ status: 'failed', reason, finishedAt: new Date().toISOString() }).catch(
		() => {}
	)
	await reporter.close().catch(() => {})
	process.exit(1)
}
process.on('SIGTERM', () => void fail('SIGTERM received'))
process.on('unhandledRejection', error => void fail(`unhandled: ${(error as Error).message}`))

try {
	const started = await setStatus({ status: 'planning', startedAt: new Date().toISOString() })
	if (started.killed) throw new Error('job was killed before it started')
	log('seeding repo', { jobId, templateDir: config.templateDir, workDir: config.workDir })
	const repoDir = await seedRepo(config.templateDir, config.workDir, jobId)
	await reporter.update({ repositoryUrl: `file://${repoDir}` })
	// The review gate diffs everything the workers did against this commit
	const seedCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim()

	const ports = createLivePorts({
		client: new Anthropic({ apiKey: config.anthropicApiKey }),
		planModel: config.planModel,
		workerModel: config.workerModel,
	})

	const outcome = await runJob(
		{
			id: job.id,
			spec: job.spec,
			budget: job.budget,
			gateWaivers: job.gateWaivers,
			repoDir,
			seedCommit,
		},
		{
			ports,
			hooks: {
				emit: async event => {
					await trackPhase(event)
					await emit(event)
				},
				onTokens: async tokensUsed => {
					await reporter.update({ tokensUsed })
				},
				// Kill switch: the api flips the row to `killed`; the orchestrator aborts on the next poll
				isKilled: async () => killedByApi || (await reporter.isKilled()),
				pollIntervalMs: 10_000,
			},
		}
	)

	// The terminal write never overrides a kill that landed after the last poll; usage, the plan
	// and the gate reports are still persisted on the killed row (the reporter keeps them).
	const final = await setStatus({
		status: outcome.status,
		tokensUsed: outcome.tokensUsed,
		plan: outcome.plan,
		reason: outcome.reason,
		gates: outcome.gates,
		finishedAt: new Date().toISOString(),
	})
	const status = final.killed ? 'killed' : final.status
	log('job finished', {
		jobId,
		status,
		tokensUsed: outcome.tokensUsed,
		gates: outcome.gates.map(gate => `${gate.name}:${gate.ok ? 'ok' : 'failed'}`),
	})
	await reporter.close()
	process.exit(status === 'delivered' ? 0 : 1)
} catch (error) {
	await fail((error as Error).message)
}
