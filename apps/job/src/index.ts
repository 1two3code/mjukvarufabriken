/**
 * Build-job entrypoint (one container = one job). Reads `JOB_ID`, loads the job + frozen spec
 * through a `JobReporter` (the api's per-job endpoint on Fargate, Postgres for
 * `npm run job:dev`), seeds the customer repo from the template, runs the `@mf/harness`
 * orchestrator and streams status / tokens / events back the same way.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import Anthropic from '@anthropic-ai/sdk'
import {
	appNameOf,
	createLiveDeliveryClients,
	createLivePorts,
	debugKeyOf,
	exec,
	runJob,
	sdkSessionQuery,
	setSessionQuery,
	slugify,
	uploadDebugBundle,
} from '@mf/harness'
import { Cassette, recordQuery, recordSpecEngineClient } from '@mf/harness/testing'

import { startAnthropicForwardProxy } from '#/anthropicForwardProxy.ts'
import { loadConfig } from '#/config.ts'
import { gitIdentity, seedRepo } from '#/repo.ts'
import { createApiReporter, createDbReporter } from '#/reporter.ts'

import type { NewJobEvent } from '@mf/models'
import type { SpecEngineClient } from '@mf/harness'
import type { JobReporter } from '#/reporter.ts'

const log = (message: string, extra?: Record<string, unknown>) =>
	console.log(JSON.stringify({ time: new Date().toISOString(), message, ...extra }))

const config = await loadConfig(process.argv.slice(2))
// The worker sessions and the repo's own scripts inherit the environment (minus what
// @mf/harness' sandboxEnv strips); the report token, the database, the secret locations and
// the GitHub token are only needed here (the GitHub token lives in config and is handed to the
// Octokit client, never to the environment the model-driven sandbox sees). This only scrubs
// Node's copy — the kernel keeps /proc/<pid>/environ as started, which is why the api reporter
// exchanges the bootstrap token before any worker runs (`claim`).
for (const key of [
	'JOB_TOKEN',
	'DATABASE_URL',
	'DATABASE_SECRET_ARN',
	'ANTHROPIC_API_KEY_SECRET_ARN',
	'GITHUB_TOKEN',
	'GITHUB_TOKEN_SECRET_ARN',
]) {
	delete process.env[key]
}
// The raw Anthropic key is NEVER put in process.env from here on (hardening audit 2026-08-30,
// Gate B finding A1): a worker session's Bash tool inherits this process's env, so a plaintext
// ANTHROPIC_API_KEY here would be as readable as `echo $ANTHROPIC_API_KEY` to a prompt-injected
// spec. Instead, a local-only forward proxy holds the real key in its own closure and injects it
// on the way out; workers get ANTHROPIC_BASE_URL pointed at it plus a harmless placeholder token
// (sessionEnv, worker.ts) — never the key itself. `packages/harness` sandboxEnv also denies
// ANTHROPIC_API_KEY by name now (defense in depth for any other exec(asWorker:true) path).
const anthropicProxy = await startAnthropicForwardProxy({ apiKey: config.anthropicApiKey })
process.env.ANTHROPIC_BASE_URL = anthropicProxy.url
process.env.ANTHROPIC_AUTH_TOKEN = 'unused-forwarded-by-local-proxy'
Object.assign(process.env, gitIdentity)

const { jobId } = config
const reporter: JobReporter =
	config.report.mode === 'api'
		? createApiReporter({ apiUrl: config.report.apiUrl, jobId, token: config.report.token })
		: await createDbReporter(config.report.databaseUrl, jobId)
log('reporting via ' + config.report.mode, { jobId })

// One-shot exchange before anything else runs: the token in the task environment (still
// readable through /proc/*/environ by every worker session, and through ecs:DescribeTasks /
// CloudTrail) is dead from here on; the replacement lives only in this process. A failed
// exchange must exit cleanly — this runs before the SIGTERM/unhandledRejection handlers below
// are registered, so an unhandled rejection here would crash the container with no clear log.
try {
	await reporter.claim?.()
} catch (error) {
	log('token claim failed, aborting before run', { jobId, reason: (error as Error).message })
	await reporter.close().catch(() => {})
	process.exit(4)
}

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

/**
 * Where the build is delivered (M5): repo `mjukvaruhuset/<app>-<job prefix>`. The customer's
 * GitHub login comes from the report view (the api resolves it from the order's creator once
 * they signed in with GitHub); without it the repo stays "transfer pending".
 */
const deliveryTarget = () => {
	const appName = appNameOf(job.spec.goal)
	return {
		slug: `${slugify(appName).slice(0, 50)}-${jobId.slice(0, 8)}`,
		appName,
		customerGithubLogin: job.customerGithubLogin,
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
	const repoDir = await seedRepo(
		config.templateDir,
		config.workDir,
		jobId,
		appNameOf(job.spec.goal)
	)
	await reporter.update({ repositoryUrl: `file://${repoDir}` })
	// The review gate diffs everything the workers did against this commit
	const seedCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim()

	const deliveryClients = createLiveDeliveryClients({
		...config.delivery,
		jobId,
		workerModel: config.workerModel,
	})
	// Record seam (off unless `MF_CASSETTE`/`--record <dir>`): wrap the planner client and the Agent
	// SDK `query()` so this one live run writes a cassette that replays offline with no tokens.
	let client: SpecEngineClient = new Anthropic({ apiKey: config.anthropicApiKey })
	if (config.cassetteDir) {
		const cassette = await Cassette.open(config.cassetteDir, 'record')
		client = recordSpecEngineClient(client, cassette)
		setSessionQuery(recordQuery(sdkSessionQuery, cassette))
		// Persist the job so the cassette replays standalone (`npm run e2e:replay -- <dir>`)
		await writeFile(
			join(config.cassetteDir, 'job.json'),
			JSON.stringify({ id: jobId, spec: job.spec, budget: job.budget, delivery: deliveryTarget() }, null, 2)
		)
		log('recording cassette', { jobId, dir: config.cassetteDir })
	}
	const ports = createLivePorts({
		client,
		planModel: config.planModel,
		workerModel: config.workerModel,
		delivery: deliveryClients,
	})
	const delivery = deliveryTarget()
	log('delivery target', { jobId, ...delivery, dryRun: config.delivery.dryRun })

	const outcome = await runJob(
		{
			id: job.id,
			spec: job.spec,
			budget: job.budget,
			gateWaivers: job.gateWaivers,
			repoDir,
			seedCommit,
			delivery,
			// Approve-before-deliver hold (W9): the flag rides in on the report view (resolved from
			// the order). When on, the orchestrator pauses after green gates until `isApproved`.
			approveBeforeDeliver: job.approveBeforeDeliver,
		},
		{
			ports,
			hooks: {
				emit: async event => {
					await trackPhase(event)
					await emit(event)
				},
				onTokens: async (tokensUsed, usage) => {
					await reporter.update({ tokensUsed, usage })
				},
				// Kill switch: the api flips the row to `killed`; the orchestrator aborts on the next poll
				isKilled: async () => killedByApi || (await reporter.isKilled()),
				// Approve-before-deliver hold (W9): mark the row awaiting approval, then poll the resume
				// signal the approve action sets. The kill switch above still aborts a parked job.
				onAwaitingApproval: async () => {
					await setStatus({ awaitingApproval: true })
				},
				isApproved: async () => reporter.isApproved(),
				pollIntervalMs: 10_000,
			},
		}
	)

	// A job that failed AFTER the build (the plan ran) leaves a real repository behind. Archive it
	// and the gate reports to `deliverables/<jobId>/debug/` so the build can be pulled once and its
	// gates re-run locally forever (`gates-demo --repo <dir>`) — no rebuild. Best-effort, and only
	// when the artifact store persists to a real bucket (`s3`): dry-run WITH a bucket still uploads
	// (that path yields the s3 store), the same rule as the delivery bundle, but dry-run WITHOUT a
	// bucket is the in-memory dry-run store, so a job without ARTIFACTS_BUCKET is unaffected — it
	// would otherwise run a full `git archive` and log "debug bundle uploaded" while storing nothing.
	if (outcome.status !== 'delivered' && outcome.plan && deliveryClients.artifacts.kind === 's3') {
		try {
			const files = await uploadDebugBundle({
				jobId,
				repoDir,
				gates: outcome.gates,
				artifacts: deliveryClients.artifacts,
			})
			log('debug bundle uploaded', {
				jobId,
				key: debugKeyOf(jobId),
				store: deliveryClients.artifacts.kind,
				files: files.map(file => file.name),
			})
		} catch (error) {
			log('debug bundle upload failed', { jobId, reason: (error as Error).message })
		}
	}

	// The terminal write never overrides a kill that landed after the last poll; usage, the plan
	// and the gate reports are still persisted on the killed row (the reporter keeps them).
	const final = await setStatus({
		status: outcome.status,
		tokensUsed: outcome.tokensUsed,
		usage: outcome.usage,
		plan: outcome.plan,
		reason: outcome.reason,
		gates: outcome.gates,
		repositoryUrl: outcome.deliverable?.repositoryUrl,
		finishedAt: new Date().toISOString(),
	})
	const status = final.killed ? 'killed' : final.status
	log('job finished', {
		jobId,
		status,
		tokensUsed: outcome.tokensUsed,
		repositoryUrl: outcome.deliverable?.repositoryUrl,
		deployUrl: outcome.deliverable?.deployUrl,
		deliverableKey: outcome.deliverable?.deliverableKey,
		gates: outcome.gates.map(gate => `${gate.name}:${gate.ok ? 'ok' : 'failed'}`),
	})
	await reporter.close()
	process.exit(status === 'delivered' ? 0 : 1)
} catch (error) {
	await fail((error as Error).message)
}
