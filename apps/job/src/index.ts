/**
 * Build-job entrypoint (one container = one job). Reads `JOB_ID`, loads the job + frozen spec
 * from Postgres, seeds the customer repo from the template, runs the `@mf/harness` orchestrator
 * and streams status / tokens / events back to the database. Same code path locally
 * (`npm run job:dev -- <id>`) and on Fargate.
 */
import Anthropic from '@anthropic-ai/sdk'
import { appendEvent, createDb, getJob, migrate, updateJob } from '@mf/db'
import { createLivePorts, exec, runJob } from '@mf/harness'
import { isActiveJobStatus } from '@mf/models'

import { loadConfig } from '#/config.ts'
import { gitIdentity, seedRepo } from '#/repo.ts'

import type { NewJobEvent } from '@mf/models'

const log = (message: string, extra?: Record<string, unknown>) =>
	console.log(JSON.stringify({ time: new Date().toISOString(), message, ...extra }))

const config = await loadConfig(process.argv.slice(2))
// The worker sessions and the repo's own scripts inherit the environment (minus what
// @mf/harness' sandboxEnv strips); the database and secret locations are only needed here.
for (const key of ['DATABASE_URL', 'DATABASE_SECRET_ARN', 'ANTHROPIC_API_KEY_SECRET_ARN']) {
	delete process.env[key]
}
process.env.ANTHROPIC_API_KEY = config.anthropicApiKey
Object.assign(process.env, gitIdentity)

const db = createDb(config.databaseUrl, { max: 3 })
const { jobId } = config
await migrate(db)

const job = await getJob(db, jobId)
if (!job) {
	log('job not found', { jobId })
	await db.close()
	process.exit(2)
}
if (!isActiveJobStatus(job.status) || job.status !== 'queued') {
	log('job is not queued, refusing to run', { jobId, status: job.status })
	await db.close()
	process.exit(3)
}

const emit = async (event: NewJobEvent) => {
	log(`event ${event.type}`, { jobId, ...event.payload })
	await appendEvent(db, jobId, event)
}

// Set when a status write is refused because the api already flipped the row to `killed`;
// the orchestrator's poll picks it up without waiting for the next database round trip.
let killedByApi = false

/** Status write that respects the kill switch: `undefined` back means the row is `killed` */
const setStatus = async (update: Parameters<typeof updateJob>[2]) => {
	const row = await updateJob(db, jobId, update)
	if (!row) killedByApi = true
	return row
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
	await appendEvent(db, jobId, { type: 'failed', payload: { reason } }).catch(() => {})
	await setStatus({ status: 'failed', reason, finishedAt: new Date() }).catch(() => {})
	await db.close().catch(() => {})
	process.exit(1)
}
process.on('SIGTERM', () => void fail('SIGTERM received'))
process.on('unhandledRejection', error => void fail(`unhandled: ${(error as Error).message}`))

try {
	if (!(await setStatus({ status: 'planning', startedAt: new Date() }))) {
		throw new Error('job was killed before it started')
	}
	log('seeding repo', { jobId, templateDir: config.templateDir, workDir: config.workDir })
	const repoDir = await seedRepo(config.templateDir, config.workDir, jobId)
	await updateJob(db, jobId, { repositoryUrl: `file://${repoDir}` })
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
					await updateJob(db, jobId, { tokensUsed })
				},
				// Kill switch: the api flips the row to `killed`; the orchestrator aborts on the next poll
				isKilled: async () => killedByApi || (await getJob(db, jobId))?.status === 'killed',
				pollIntervalMs: 10_000,
			},
		}
	)

	// The terminal write never overrides a kill that landed after the last poll; usage, the plan
	// and the gate reports are still persisted on the killed row.
	const finalRow = await setStatus({
		status: outcome.status,
		tokensUsed: outcome.tokensUsed,
		plan: outcome.plan,
		reason: outcome.reason,
		gates: outcome.gates,
		finishedAt: new Date(),
	})
	if (!finalRow) {
		await updateJob(db, jobId, {
			tokensUsed: outcome.tokensUsed,
			plan: outcome.plan,
			gates: outcome.gates,
		})
	}
	const status = finalRow?.status ?? 'killed'
	log('job finished', {
		jobId,
		status,
		tokensUsed: outcome.tokensUsed,
		gates: outcome.gates.map(gate => `${gate.name}:${gate.ok ? 'ok' : 'failed'}`),
	})
	await db.close()
	process.exit(status === 'delivered' ? 0 : 1)
} catch (error) {
	await fail((error as Error).message)
}
