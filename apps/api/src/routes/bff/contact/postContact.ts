import { z } from 'zod'

import { clientIp } from '#/routes/bff/contact/contact.utils.ts'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const contactBodySchema = z.object({
	name: z.string().trim().min(1).max(200),
	email: z.email().max(320),
	company: z.string().trim().max(200).optional(),
	message: z.string().trim().min(10).max(5000),
})

const schema = {
	body: contactBodySchema,
	response: { 202: z.object({}) },
}

/**
 * Public route (listed in `publicUrls`). Forwards the message to the admins; 429 when the ip
 * has sent too many messages, 202 otherwise — including when nobody is configured to receive
 * it, which is an ops problem the sender cannot act on (the service logs it).
 */
const route: FastifyPluginAsyncZod = async function (app) {
	app.post('/bff/contact', { schema }, async (request, reply) => {
		const { body, headers, ip } = request
		const { company, ...rest } = body
		const message = company ? { ...rest, company } : rest

		try {
			const result = await app.contactService.submit(
				message,
				clientIp(headers['x-forwarded-for'], ip)
			)
			if (result === 'rateLimited') {
				return reply.error(429, new Error('Too many messages'), 'contactRateLimited')
			}
		} catch (error) {
			return reply.error(500, error as Error)
		}
		return reply.code(202).send({})
	})
}

export default route
