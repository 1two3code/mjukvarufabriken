import fp from 'fastify-plugin'

import type { FastifyPluginAsync } from 'fastify'

/** A message posted through the public contact form on the site */
export type ContactMessage = {
	name: string
	email: string
	company?: string
	message: string
}

export const contactResults = ['sent', 'rateLimited', 'unconfigured'] as const
export type ContactResult = (typeof contactResults)[number]

/** Max messages per client ip within the window — same shape as the magic-link limit */
export const contactRateLimit = { max: 5, windowMinutes: 10 } as const

declare module 'fastify' {
	interface FastifyInstance {
		contactService: {
			/**
			 * Forwards a contact-form message to every `AUTH_ADMIN_EMAILS` address through the
			 * `email` plugin. `rateLimited` when `ip` has sent `contactRateLimit.max` messages in
			 * the window already, `unconfigured` when there is nobody to send to (logged).
			 */
			submit: (message: ContactMessage, ip: string) => Promise<ContactResult>
		}
	}
}

// MARK: Helpers
const windowMs = contactRateLimit.windowMinutes * 60 * 1000

/** Keeps the send timestamps per ip and prunes everything outside the window on each call */
const createRateLimiter = () => {
	const sentAt = new Map<string, number[]>()
	return {
		isLimited: (ip: string, now: number) => {
			const recent = (sentAt.get(ip) ?? []).filter(time => now - time < windowMs)
			if (recent.length >= contactRateLimit.max) {
				sentAt.set(ip, recent)
				return true
			}
			sentAt.set(ip, [...recent, now])
			return false
		},
	}
}

const singleLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim()

export const contactEmail = ({ name, email, company, message }: ContactMessage) => {
	const from = company ? `${singleLine(name)} (${singleLine(company)})` : singleLine(name)
	return {
		subject: `Kontakt via mjukvaruhuset.se: ${from}`,
		text: [
			`Namn: ${singleLine(name)}`,
			`E-post: ${singleLine(email)}`,
			...(company ? [`Företag: ${singleLine(company)}`] : []),
			'',
			message.trim(),
		].join('\n'),
	}
}

// MARK: Plugin
const plugin: FastifyPluginAsync = async app => {
	const { secrets, email: mailer } = app
	const limiter = createRateLimiter()

	app.decorate('contactService', {
		submit: async (message, ip) => {
			if (limiter.isLimited(ip, Date.now())) {
				app.log.warn({ ip }, 'Contact form rate limit hit')
				return 'rateLimited'
			}

			const recipients = secrets.authAdminEmails
			if (!recipients.length) {
				app.log.error({ message }, 'Contact form message dropped: AUTH_ADMIN_EMAILS is empty')
				return 'unconfigured'
			}

			const content = contactEmail(message)
			await Promise.all(recipients.map(to => mailer.send({ to, ...content })))
			return 'sent'
		},
	})
}

export default fp(plugin, {
	name: '#internal/contactService',
	dependencies: ['#internal/secrets', '#internal/email'],
})
