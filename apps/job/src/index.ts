/**
 * Build-job entrypoint (one container = one job). Reads `JOB_ID`, loads the job + frozen spec
 * from Postgres, seeds the customer repo from the template, runs the `@mf/harness` orchestrator
 * and streams status / tokens / events back to the database. Same code path locally
 * (`npm run job:dev -- <id>`) and on Fargate.
 */
import Anthropic from '@anthropic-ai/sdk'
import { appendEvent, createDb, getJob, migrate, updateJob } from '@mf/db'
import { createLivePorts, runJob } from '@mf/harness'
import { isActiveJobStatus } from '@mf/models'

import { loadConfig } from '#/config.ts'
import { gitIdentity, seedRepo } from '#/repo.ts'

import type { NewJobEvent } from '@mf/models'

const log = (message: string, extra?: Record<string, unknown>) =>
	console.log(JSON.stringify({ time: new Date().toISOString(), message, ...extra }))

const config = await loadConfig(process.argv.slice(2))
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

let phaseStatus: 'planning' | 'building' | 'verifying' = 'planning'
const trackPhase = async (event: NewJobEvent) => {
	const next =
		event.type === 'planned' ? 'building' : event.type === 'verify' ? 'verifying' : undefined
	if (next && next !== phaseStatus) {
		phaseStatus = next
		await updateJob(db, jobId, { status: next })
	}
}

await updateJob(db, jobId, { status: 'planning', startedAt: new Date() })
log('seeding repo', { jobId, templateDir: config.templateDir, workDir: config.workDir })
const repoDir = await seedRepo(config.templateDir, config.workDir, jobId)
await updateJob(db, jobId, { repositoryUrl: `file://${repoDir}` })

const ports = createLivePorts({
	client: new Anthropic({ apiKey: config.anthropicApiKey }),
	planModel: config.planModel,
	workerModel: config.workerModel,
})

const outcome = await runJob(
	{ id: job.id, spec: job.spec, budget: job.budget, repoDir },
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
			isKilled: async () => (await getJob(db, jobId))?.status === 'killed',
			pollIntervalMs: 10_000,
		},
	}
)

await updateJob(db, jobId, {
	status: outcome.status,
	tokensUsed: outcome.tokensUsed,
	plan: outcome.plan,
	reason: outcome.reason,
	finishedAt: new Date(),
})
log('job finished', { jobId, status: outcome.status, tokensUsed: outcome.tokensUsed })
await db.close()
process.exit(outcome.status === 'delivered' ? 0 : 1)
