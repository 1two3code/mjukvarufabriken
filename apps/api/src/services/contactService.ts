import fp from 'fastify-plugin'
import { createMemoryRepositories } from '@mf/db'

import type { FastifyPluginAsync } from 'fastify'
import type { Repositories } from '@mf/db'

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
			 * nobody to send to (logged). Every send attempt counts toward the limits — the hit is
			 * recorded before the email goes out, like the magic-link limiter — so a burst cannot
			 * outrun the counter by the length of the mailer round-trip and a failed send never
			 * turns into an unlimited retry. Throws when no recipient could be reached.
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

	/**
	 * The contact form only needs the mailer, so it must keep working through a database outage
	 * (configured but unreadable secret, failed migration): when `db` is unavailable the limits
	 * fall back to a process-local limiter instead of every submission failing with 500. The
	 * fallback is per api task, which is the pre-Postgres behaviour; the degradation is logged.
	 */
	let fallback: Repositories['rateLimits'] | undefined
	const rateLimits = (): Repositories['rateLimits'] => {
		if (db.available) return db.rateLimits
		if (!fallback) {
			app.log.warn('Database unavailable: contact form rate limits are process-local')
			fallback = createMemoryRepositories().rateLimits
		}
		return fallback
	}

	/** Whether a send from `ip` right now would exceed the per-ip or global limit */
	const isLimited = async (ip: string, now: Date) => {
		const since = new Date(now.getTime() - windowMs)
		const global = await rateLimits().count(contactRateLimitScope, undefined, since)
		if (global >= contactRateLimit.globalMax) return true
		return (await rateLimits().count(contactRateLimitScope, ip, since)) >= contactRateLimit.max
	}

	// Rows older than the window count for nothing: the `pruner` plugin drops them hourly (Postgres
	// only) via `db.rateLimits.pruneExpired()`.

	app.decorate('contactService', {
		submit: async (message, ip) => {
			const now = new Date()
			if (await isLimited(ip, now)) {
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

			// Count the attempt before sending: once the email is out, a failure here would tell
			// the visitor it failed although the admins got it (and invite a duplicate)
			await rateLimits().record(contactRateLimitScope, ip, now)

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
			return 'sent'
		},
	})
}

export default fp(plugin, {
	name: '#internal/contactService',
	dependencies: ['#internal/db', '#internal/secrets', '#internal/email'],
})
