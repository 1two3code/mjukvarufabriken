import { z } from 'zod'

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
 * Number of trusted proxies that append to `x-forwarded-for` in front of the api. In AWS it is
 * CloudFront → ALB (2); override with `TRUSTED_PROXY_HOPS` (e.g. 1 when calling the ALB directly).
 */
export const trustedProxyHops = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS) || 2)

/**
 * The client ip behind the proxies: every proxy APPENDS the address it saw, so anything the
 * caller put in the header itself sits to the left of the last `hops` entries and is ignored.
 * With fewer entries than hops the leftmost one is still proxy-added. No header → socket ip.
 */
export const clientIp = (
	forwardedFor: string | string[] | undefined,
	fallback: string,
	hops = trustedProxyHops
) => {
	const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor
	const entries = (header ?? '')
		.split(',')
		.map(entry => entry.trim())
		.filter(Boolean)
	if (!entries.length) return fallback
	return entries[Math.max(0, entries.length - hops)]!.slice(0, 64)
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
