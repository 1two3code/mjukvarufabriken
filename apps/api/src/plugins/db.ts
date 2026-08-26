import fp from 'fastify-plugin'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import {
	appendEvent,
	connectionStringFromSecret,
	createDb,
	getJob,
	insertJob,
	listEvents,
	listJobs,
	migrate,
	updateJob,
} from '@mf/db'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { DatabaseSecret, Db, JobUpdate, NewJob } from '@mf/db'
import type { Job, JobEvent, NewJobEvent } from '@mf/models'

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * Postgres via @mf/db. `available` is false when neither `DATABASE_URL` nor
		 * `DATABASE_SECRET_ARN` is set — the api still boots and job routes fail per request.
		 * Only the job tables live here so far; orders/specs/users move over in M6.
		 */
		db: {
			available: boolean
			/** Set when a database is configured but its migrations failed — /health reports 503 */
			error?: string
			jobs: {
				insert: (job: NewJob) => Promise<Job>
				get: (id: string) => Promise<Job | undefined>
				list: (filter?: { orderId?: string; orgId?: string }) => Promise<Job[]>
				update: (id: string, update: JobUpdate) => Promise<Job | undefined>
				appendEvent: (jobId: string, event: NewJobEvent) => Promise<JobEvent>
				listEvents: (jobId: string, afterId?: number) => Promise<JobEvent[]>
			}
		}
	}
}

export class DatabaseNotConfigured extends Error {
	constructor() {
		super('Database is not configured (DATABASE_URL / DATABASE_SECRET_ARN)')
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

const createJobsRepository = (db: Db) => ({
	insert: (job: NewJob) => insertJob(db, job),
	get: (id: string) => getJob(db, id),
	list: (filter?: { orderId?: string; orgId?: string }) => listJobs(db, filter),
	update: (id: string, update: JobUpdate) => updateJob(db, id, update),
	appendEvent: (jobId: string, event: NewJobEvent) => appendEvent(db, jobId, event),
	listEvents: (jobId: string, afterId?: number) => listEvents(db, jobId, afterId),
})

/** Every repository call rejects with the given error */
const unavailableRepository = (error: () => Error): FastifyInstance['db']['jobs'] => {
	const reject = () => Promise.reject(error())
	return {
		insert: reject,
		get: reject,
		list: reject,
		update: reject,
		appendEvent: reject,
		listEvents: reject,
	}
}

const plugin: FastifyPluginAsync = async app => {
	const connectionString = await resolveConnectionString().catch(error => {
		app.log.warn({ err: error }, 'Could not resolve the database secret')
		return undefined
	})

	if (!connectionString) {
		app.log.warn('Database not configured — job routes unavailable')
		app.decorate('db', {
			available: false,
			jobs: unavailableRepository(() => new DatabaseNotConfigured()),
		})
		return
	}

	const db = createDb(connectionString)
	app.addHook('onClose', () => db.close())
	// RDS lives in isolated subnets, so the api applies pending migrations itself at boot
	// (idempotent, serialised by an advisory lock, tracked in schema_migrations). A failure is
	// never masked: the repository becomes unavailable and /health reports 503, so a rollout
	// with a broken migration cannot pass as healthy while every job route 500s.
	try {
		const result = await migrate(db)
		if (result.applied.length) app.log.info({ applied: result.applied }, 'Migrations applied')
	} catch (error) {
		app.log.error({ err: error }, 'Could not run database migrations — database unavailable')
		app.decorate('db', {
			available: false,
			error: (error as Error).message,
			jobs: unavailableRepository(() => new DatabaseUnavailable(error as Error)),
		})
		return
	}
	app.decorate('db', { available: true, jobs: createJobsRepository(db) })
}

export default fp(plugin, { name: '#internal/db', dependencies: ['#internal/secrets'] })
