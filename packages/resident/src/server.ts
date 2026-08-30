import { fastify } from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { z } from 'zod'
import {
	NewResidentTaskSchema,
	ResidentAuditResponseSchema,
	ResidentDaySchema,
	ResidentPauseResponseSchema,
	ResidentStatusSchema,
	ResidentTaskSchema,
	ResidentTasksResponseSchema,
} from '@mf/models'

import { dayOf } from '#/metering.ts'

import type { FastifyInstance, LogLevel } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import type { Resident } from '#/resident.ts'

export type ServerOptions = {
	resident: Resident
	/** Bearer required on everything but `/health`; undefined → open (only reachable inside the VPC) */
	adminToken?: string
	logLevel?: LogLevel
	now?: () => number
}

const errorSchema = z.object({ message: z.string() })

/**
 * The resident's control surface: status, pause/resume, tasks and the audit log. It is the
 * customer's own service in their own account, so there is no session — one bearer token
 * (`RESIDENT_ADMIN_TOKEN`, a secret in their account) guards every endpoint but `/health`.
 */
export const createServer = async ({
	resident,
	adminToken,
	logLevel = 'info',
	now = Date.now,
}: ServerOptions): Promise<FastifyInstance> => {
	const server = fastify({ logger: { level: logLevel } }).withTypeProvider<ZodTypeProvider>()
	server.setValidatorCompiler(validatorCompiler)
	server.setSerializerCompiler(serializerCompiler)

	server.addHook('onRequest', async (request, reply) => {
		if (!adminToken || request.url === '/health') return
		const header = request.headers.authorization ?? ''
		const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
		if (token !== adminToken) return reply.code(401).send({ message: 'Unauthorized' })
	})

	server.get('/health', { logLevel: 'silent' }, async () => ({ message: 'OK' }))

	server.get('/status', { schema: { response: { 200: ResidentStatusSchema } } }, () =>
		resident.status()
	)

	server.post(
		'/pause',
		{ schema: { response: { 200: ResidentPauseResponseSchema } } },
		async () => ({
			paused: await resident.pause('api'),
		})
	)

	server.post(
		'/resume',
		{ schema: { response: { 200: ResidentPauseResponseSchema } } },
		async () => ({ paused: await resident.resume('api') })
	)

	server.get('/tasks', { schema: { response: { 200: ResidentTasksResponseSchema } } }, () => ({
		tasks: resident.tasks(),
	}))

	server.post(
		'/tasks',
		{
			schema: {
				body: NewResidentTaskSchema,
				response: { 201: ResidentTaskSchema, 409: errorSchema },
			},
		},
		async (request, reply) => {
			const task = await resident.addTask(request.body)
			return reply.code(201).send(task)
		}
	)

	server.get(
		'/audit',
		{
			schema: {
				querystring: z.object({ day: ResidentDaySchema.optional() }),
				response: { 200: ResidentAuditResponseSchema },
			},
		},
		async request => {
			const day = request.query.day ?? dayOf(now())
			return { day, entries: await resident.audit.read(day) }
		}
	)

	return server
}
