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

import type { FastifyPluginAsync } from 'fastify'
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

const unavailable = () => Promise.reject(new DatabaseNotConfigured())

const plugin: FastifyPluginAsync = async app => {
	const connectionString = await resolveConnectionString().catch(error => {
		app.log.warn({ err: error }, 'Could not resolve the database secret')
		return undefined
	})

	if (!connectionString) {
		app.log.warn('Database not configured — job routes unavailable')
		app.decorate('db', {
			available: false,
			jobs: {
				insert: unavailable,
				get: unavailable,
				list: unavailable,
				update: unavailable,
				appendEvent: unavailable,
				listEvents: unavailable,
			},
		})
		return
	}

	const db = createDb(connectionString)
	// RDS lives in isolated subnets, so the api applies pending migrations itself at boot
	// (idempotent, tracked in schema_migrations). A failure here is logged, not fatal.
	try {
		const result = await migrate(db)
		if (result.applied.length) app.log.info({ applied: result.applied }, 'Migrations applied')
	} catch (error) {
		app.log.warn({ err: error }, 'Could not run database migrations')
	}
	app.decorate('db', { available: true, jobs: createJobsRepository(db) })
	app.addHook('onClose', () => db.close())
}

export default fp(plugin, { name: '#internal/db', dependencies: ['#internal/secrets'] })
