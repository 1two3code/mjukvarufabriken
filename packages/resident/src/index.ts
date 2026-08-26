/**
 * Resident agent entrypoint (one container = one customer repository). Loads its configuration
 * from the environment / Secrets Manager, wires the harness ports, the GitHub client, the S3
 * store and the factory reporter (fakes under `RESIDENT_DRY_RUN`), starts the control api and
 * loops: pick up issues → build one task → report usage, forever, unless paused or capped.
 */
import Anthropic from '@anthropic-ai/sdk'
import { createLivePorts } from '@mf/harness'

import { loadConfig } from '#/config.ts'
import { createFactoryReporter, createNoopUsageReporter } from '#/factory.ts'
import { createFakeGitHub, createOctokitResidentGitHub } from '#/github.ts'
import { createFakeWorkspace, createGitWorkspace, createResident } from '#/resident.ts'
import { createServer } from '#/server.ts'
import { createMemoryObjectStore, createS3ObjectStore } from '#/store.ts'

import type { OrchestratorPorts } from '@mf/harness'

const log = (message: string, extra?: Record<string, unknown>) =>
	console.log(JSON.stringify({ time: new Date().toISOString(), message, ...extra }))

const config = await loadConfig()

// The worker sessions and the repo's own scripts inherit the environment (minus what
// @mf/harness' sandboxEnv strips): the tokens are only needed here.
for (const key of [
	'GITHUB_TOKEN',
	'GITHUB_TOKEN_SECRET_ARN',
	'ANTHROPIC_API_KEY_SECRET_ARN',
	'FACTORY_TOKEN',
	'FACTORY_TOKEN_SECRET_ARN',
	'RESIDENT_ADMIN_TOKEN',
	'RESIDENT_ADMIN_TOKEN_SECRET_ARN',
]) {
	delete process.env[key]
}
if (config.anthropicApiKey) process.env.ANTHROPIC_API_KEY = config.anthropicApiKey
Object.assign(process.env, {
	GIT_AUTHOR_NAME: 'Mjukvaruhuset resident',
	GIT_AUTHOR_EMAIL: 'resident@mjukvaruhuset.se',
	GIT_COMMITTER_NAME: 'Mjukvaruhuset resident',
	GIT_COMMITTER_EMAIL: 'resident@mjukvaruhuset.se',
})

/** Ports that fail every task with a clear reason when the model key is missing (never a crash) */
const unconfiguredPorts = (reason: string): OrchestratorPorts => {
	const fail = async () => {
		throw new Error(reason)
	}
	return {
		plan: fail,
		runTask: fail,
		mergeTask: fail,
		verify: fail,
		acceptanceTests: fail,
		review: fail,
		acceptanceCheck: fail,
	}
}

const github = config.dryRun
	? createFakeGitHub([], config.repository)
	: config.githubToken
		? createOctokitResidentGitHub({ repository: config.repository, token: config.githubToken })
		: undefined
if (!github) throw new Error('GITHUB_TOKEN (or GITHUB_TOKEN_SECRET_ARN) is required')

const store =
	config.bucket && !config.dryRun
		? createS3ObjectStore(config.bucket, config.region)
		: createMemoryObjectStore()
if (!config.bucket && !config.dryRun) {
	log('RESIDENT_BUCKET not set — audit log and usage records are kept in memory only')
}

const ports = config.dryRun
	? unconfiguredPorts('dry run: no model configured')
	: config.anthropicApiKey
		? createLivePorts({
				client: new Anthropic({ apiKey: config.anthropicApiKey }),
				planModel: config.planModel,
				workerModel: config.workerModel,
			})
		: unconfiguredPorts('ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY_SECRET_ARN) is not configured')

const resident = createResident({
	installationId: config.installationId,
	repository: config.repository,
	store,
	github,
	ports,
	usageReporter: config.factory ? createFactoryReporter(config.factory) : createNoopUsageReporter(),
	workspace: config.dryRun ? createFakeWorkspace() : createGitWorkspace(config.workDir, github),
	monthlyTokens: config.monthlyTokens,
	task: {
		maxTokens: config.taskTokens,
		maxDurationMinutes: config.taskDurationMinutes,
		maxWorkers: config.taskWorkers,
	},
	pausedByEnv: config.pausedByEnv,
	planModel: config.planModel,
	workerModel: config.workerModel,
	prices: config.prices,
	log,
})

await resident.start()
const server = await createServer({
	resident,
	adminToken: config.adminToken,
	logLevel: (process.env.LOG_LEVEL as 'info') || 'info',
})
await server.listen({ host: config.address, port: config.port })
log('resident listening', {
	repository: config.repository,
	installationId: config.installationId,
	port: config.port,
	dryRun: config.dryRun,
	paused: resident.paused,
	monthlyTokens: config.monthlyTokens,
})

let stopping = false
const stop = async (signal: string) => {
	if (stopping) return
	stopping = true
	log('stopping', { signal })
	// A task in flight is aborted through the kill switch; the last usage record is flushed
	resident.stop()
	await resident.flushUsage().catch(() => {})
	await resident.audit.flush()
	await server.close()
	process.exit(0)
}
process.on('SIGTERM', () => void stop('SIGTERM'))
process.on('SIGINT', () => void stop('SIGINT'))

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
while (!stopping) {
	try {
		await resident.tick()
	} catch (error) {
		log('tick failed', { error: (error as Error).message })
	}
	await sleep(config.pollIntervalMs)
}
