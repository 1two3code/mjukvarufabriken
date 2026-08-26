import fp from 'fastify-plugin'

import { scheduleHousekeeping } from '#/lib/housekeeping.ts'

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

/** Scope of the contact-form hits in `db.rateLimits` */
export const contactRateLimitScope = 'contact'

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
	const { db, secrets, email: mailer } = app
	const { rateLimits } = db

	/** Whether a send from `ip` right now would exceed the per-ip or global limit */
	const isLimited = async (ip: string, now: Date) => {
		const since = new Date(now.getTime() - windowMs)
		const global = await rateLimits.count(contactRateLimitScope, undefined, since)
		if (global >= contactRateLimit.globalMax) return true
		return (await rateLimits.count(contactRateLimitScope, ip, since)) >= contactRateLimit.max
	}

	// Rows older than the window count for nothing: drop them hourly (Postgres only)
	await scheduleHousekeeping(app, 'Rate-limit prune', () =>
		rateLimits.prune(new Date(Date.now() - windowMs))
	)

	app.decorate('contactService', {
		submit: async (message, ip) => {
			if (await isLimited(ip, new Date())) {
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
			await rateLimits.record(contactRateLimitScope, ip, new Date())
			return 'sent'
		},
	})
}

export default fp(plugin, {
	name: '#internal/contactService',
	dependencies: ['#internal/db', '#internal/secrets', '#internal/email'],
})
