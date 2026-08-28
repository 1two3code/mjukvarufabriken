import fp from 'fastify-plugin'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import {
	connectionStringFromSecret,
	createDb,
	createMemoryRepositories,
	createPostgresRepositories,
	migrate,
} from '@mf/db'
import { tryCatch } from '@mf/utils/function'

import type { FastifyPluginAsync } from 'fastify'
import type { DatabaseSecret, Repositories } from '@mf/db'

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * The repositories from @mf/db (`jobs`, `orders`, `users`, `auth`, `resident`). Postgres-backed when
		 * The repositories from @mf/db (`jobs`, `orders`, `users`, `auth`, `rateLimits`). Postgres-backed when
		 * `DATABASE_URL` or `DATABASE_SECRET_ARN` is set, otherwise the in-memory implementation
		 * (local dev without docker, tests) — same interface, everything lost on restart.
		 */
		db: Repositories & {
			/** False only when a database is configured but cannot be used (see `error`) */
			available: boolean
			backend: 'postgres' | 'memory'
			/**
			 * Set when a database is configured but cannot be used (secret unresolvable, migrations
			 * failed) — /health reports 503
			 */
			error?: string
		}
	}
}

export class DatabaseUnavailable extends Error {
	constructor(reason: 'migrations failed' | 'secret unresolvable', cause: Error) {
		super(`Database unavailable: ${reason} (${cause.message})`, { cause })
	}
}

const resolveConnectionString = async () => {
	const fromEnv = process.env.DATABASE_URL?.trim()
	if (fromEnv) return fromEnv
	const arn = process.env.DATABASE_SECRET_ARN
	if (!arn) return undefined
	const client = new SecretsManagerClient({})
	try {
		const result = await client.send(new GetSecretValueCommand({ SecretId: arn }))
		return connectionStringFromSecret(JSON.parse(result.SecretString ?? '{}') as DatabaseSecret)
	} finally {
		client.destroy()
	}
}

/** Every repository method rejects with the given error */
const unavailableRepositories = (error: () => Error): Repositories => {
	const reject = () => Promise.reject(error())
	const repository = <T extends object>(keys: (keyof T)[]) =>
		Object.fromEntries(keys.map(key => [key, reject])) as T
	return {
		jobs: repository([
			'insert',
			'listStuck',
			'get',
			'getByReportToken',
			'list',
			'update',
			'appendEvent',
			'appendEventOnce',
			'countEvents',
			'listEvents',
		]),
		orders: repository([
			'get',
			'list',
			'upsert',
			'updateUnlessFrozen',
			'insert',
			'getOrder',
			'listOrders',
			'transition',
			'insertPayment',
			'getPayment',
			'findPaymentBySession',
			'listPayments',
			'markPaymentPaid',
			'recordPaymentEvent',
			'forgetPaymentEvent',
		]),
		users: repository([
			'get',
			'findByEmail',
			'insert',
			'insertWithOrg',
			'getOrg',
			'insertOrg',
			'listOrgs',
		]),
		auth: repository([
			'insertMagicLink',
			'getMagicLink',
			'consumeMagicLink',
			'countMagicLinksSince',
			'insertRefreshToken',
			'consumeRefreshToken',
			'revokeRefreshToken',
			'pruneExpired',
		]),
		resident: repository([
			'getInstallation',
			'listInstallations',
			'upsertInstallation',
			'upsertUsage',
			'listUsage',
			'summarizeUsage',
			'getUsageReport',
			'listUsageReports',
			'upsertUsageReport',
		]),
		rateLimits: repository(['count', 'record', 'pruneExpired']),
	}
}

/** Decorates `app.db` with repositories that reject, so the failure surfaces on every call */
const decorateUnavailable = (
	app: Parameters<FastifyPluginAsync>[0],
	reason: 'migrations failed' | 'secret unresolvable',
	cause: Error
) => {
	app.decorate('db', {
		available: false,
		backend: 'postgres',
		error: cause.message,
		...unavailableRepositories(() => new DatabaseUnavailable(reason, cause)),
	})
}

const plugin: FastifyPluginAsync = async app => {
	// A configured but unreadable secret is a failure, never a reason to fall back to memory:
	// a task running on RAM behind a healthy ALB would lose logins and specs at the next restart
	const [secretError, connectionString] = await tryCatch(resolveConnectionString())
	if (secretError) {
		app.log.error(
			{ err: secretError },
			'Could not resolve the database secret — database unavailable'
		)
		return decorateUnavailable(app, 'secret unresolvable', secretError)
	}

	if (!connectionString) {
		app.log.warn(
			'Database not configured (DATABASE_URL / DATABASE_SECRET_ARN) — using the in-memory repositories, data is lost on restart'
		)
		app.decorate('db', { available: true, backend: 'memory', ...createMemoryRepositories() })
		return
	}

	const db = createDb(connectionString)
	app.addHook('onClose', () => db.close())
	// RDS lives in isolated subnets, so the api applies pending migrations itself at boot
	// (idempotent, serialised by an advisory lock, tracked in schema_migrations). A failure is
	// never masked: the repositories become unavailable and /health reports 503, so a rollout
	// with a broken migration cannot pass as healthy while every route 500s.
	try {
		const result = await migrate(db)
		if (result.applied.length) app.log.info({ applied: result.applied }, 'Migrations applied')
	} catch (error) {
		app.log.error({ err: error }, 'Could not run database migrations — database unavailable')
		return decorateUnavailable(app, 'migrations failed', error as Error)
	}
	app.log.info('Database: Postgres (migrations up to date)')
	app.decorate('db', { available: true, backend: 'postgres', ...createPostgresRepositories(db) })
}

export default fp(plugin, { name: '#internal/db', dependencies: ['#internal/secrets'] })
