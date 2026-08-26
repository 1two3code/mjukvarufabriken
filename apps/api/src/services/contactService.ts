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

/**
 * Max messages per client ip within the window — same shape as the magic-link limit — plus a
 * global ceiling across all ips for the same window, so a caller who manages to vary the ip
 * key still cannot turn the form into an unbounded SES/inbox flood.
 */
export const contactRateLimit = { max: 5, globalMax: 60, windowMinutes: 10 } as const

/** Upper bound on tracked ip keys; beyond it the oldest keys are evicted (memory guard) */
export const contactRateLimitMaxKeys = 10_000

declare module 'fastify' {
	interface FastifyInstance {
		contactService: {
			/**
			 * Forwards a contact-form message to every `AUTH_ADMIN_EMAILS` address through the
			 * `email` plugin. `rateLimited` when `ip` has sent `contactRateLimit.max` messages in
			 * the window already (or the global ceiling is reached), `unconfigured` when there is
			 * nobody to send to (logged). Only a delivered message counts toward the limits.
			 * Throws when no recipient could be reached.
			 */
			submit: (message: ContactMessage, ip: string) => Promise<ContactResult>
		}
	}
}

// MARK: Helpers
const windowMs = contactRateLimit.windowMinutes * 60 * 1000

const inWindow = (times: number[], now: number) => times.filter(time => now - time < windowMs)

/**
 * Keeps the send timestamps per ip plus a global list. Entries are pruned on every call and
 * keys without recent sends are dropped, so the map only holds ips active within the window
 * (and never more than `contactRateLimitMaxKeys` of them).
 */
export const createRateLimiter = () => {
	const sentAt = new Map<string, number[]>()
	let globalSentAt: number[] = []

	const sweep = (now: number) => {
		globalSentAt = inWindow(globalSentAt, now)
		for (const [key, times] of sentAt) {
			const recent = inWindow(times, now)
			if (recent.length) sentAt.set(key, recent)
			else sentAt.delete(key)
		}
	}

	return {
		/** Whether a send from `ip` right now would exceed the per-ip or global limit */
		isLimited: (ip: string, now: number) => {
			sweep(now)
			if (globalSentAt.length >= contactRateLimit.globalMax) return true
			return (sentAt.get(ip)?.length ?? 0) >= contactRateLimit.max
		},
		/** Counts a delivered message for `ip` */
		record: (ip: string, now: number) => {
			globalSentAt.push(now)
			// Re-insert so the key moves to the end: Map iteration order == insertion order
			const times = sentAt.get(ip) ?? []
			sentAt.delete(ip)
			sentAt.set(ip, [...times, now])
			while (sentAt.size > contactRateLimitMaxKeys) {
				const oldest = sentAt.keys().next().value
				if (oldest === undefined) break
				sentAt.delete(oldest)
			}
		},
		/** Number of tracked ip keys (for tests) */
		size: () => sentAt.size,
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
				// Only the sender's address, never the free text (PII in logs)
				app.log.error(
					{ from: message.email },
					'Contact form message dropped: AUTH_ADMIN_EMAILS is empty'
				)
				return 'unconfigured'
			}

			const content = contactEmail(message)
			const outcomes = await Promise.allSettled(
				recipients.map(to => mailer.send({ to, ...content }))
			)
			const failed = outcomes.flatMap((outcome, index) =>
				outcome.status === 'rejected' ? [{ to: recipients[index], error: outcome.reason }] : []
			)

			// Delivered to at least one admin counts as sent — a retry would only duplicate it
			if (failed.length === recipients.length) {
				throw failed[0]!.error instanceof Error
					? failed[0]!.error
					: new Error('Contact form email failed for every recipient')
			}
			for (const { to, error } of failed) {
				app.log.error({ to, error }, 'Contact form email failed for a recipient')
			}
			limiter.record(ip, Date.now())
			return 'sent'
		},
	})
}

export default fp(plugin, {
	name: '#internal/contactService',
	dependencies: ['#internal/secrets', '#internal/email'],
})
