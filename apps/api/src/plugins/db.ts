import fp from 'fastify-plugin'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import {
	connectionStringFromSecret,
	createDb,
	createMemoryRepositories,
	createPostgresRepositories,
	migrate,
} from '@mf/db'

import type { FastifyPluginAsync } from 'fastify'
import type { DatabaseSecret, Repositories } from '@mf/db'

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * The repositories from @mf/db (`jobs`, `orders`, `users`, `auth`). Postgres-backed when
		 * `DATABASE_URL` or `DATABASE_SECRET_ARN` is set, otherwise the in-memory implementation
		 * (local dev without docker, tests) — same interface, everything lost on restart.
		 */
		db: Repositories & {
			/** False only when a database is configured but cannot be used (see `error`) */
			available: boolean
			backend: 'postgres' | 'memory'
			/** Set when a database is configured but its migrations failed — /health reports 503 */
			error?: string
		}
	}
}

export class DatabaseUnavailable extends Error {
	constructor(cause: Error) {
		super(`Database unavailable: migrations failed (${cause.message})`, { cause })
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
		jobs: repository(['insert', 'get', 'list', 'update', 'appendEvent', 'listEvents']),
		orders: repository(['get', 'list', 'upsert']),
		users: repository(['get', 'findByEmail', 'insert', 'getOrg', 'insertOrg', 'listOrgs']),
		auth: repository([
			'insertMagicLink',
			'getMagicLink',
			'consumeMagicLink',
			'countMagicLinksSince',
			'insertRefreshToken',
			'consumeRefreshToken',
			'revokeRefreshToken',
		]),
	}
}

const plugin: FastifyPluginAsync = async app => {
	const connectionString = await resolveConnectionString().catch(error => {
		app.log.warn({ err: error }, 'Could not resolve the database secret')
		return undefined
	})

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
		app.decorate('db', {
			available: false,
			backend: 'postgres',
			error: (error as Error).message,
			...unavailableRepositories(() => new DatabaseUnavailable(error as Error)),
		})
		return
	}
	app.log.info('Database: Postgres (migrations up to date)')
	app.decorate('db', { available: true, backend: 'postgres', ...createPostgresRepositories(db) })
}

export default fp(plugin, { name: '#internal/db', dependencies: ['#internal/secrets'] })
