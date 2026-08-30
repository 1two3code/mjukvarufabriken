import fp from 'fastify-plugin'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'
import { isAdminEmail, normalizeEmail, orgNameFromEmail } from '#/services/userService.utils.ts'

import type { FastifyPluginAsync } from 'fastify'
import type { Org, User } from '@mf/models'

declare module 'fastify' {
	interface FastifyInstance {
		userService: {
			get: (id: string) => Promise<User>
			getOrg: (id: string) => Promise<Org>
			findByEmail: (email: string) => Promise<User | undefined>
			/**
			 * Returns the user for the email, creating it — and an org named after the email
			 * domain — on first sign-in. Role is `admin` when the email is in `AUTH_ADMIN_EMAILS`.
			 */
			findOrCreateByEmail: (email: string) => Promise<User>
		}
	}
}

const isUniqueViolation = (error: unknown) => (error as { code?: string }).code === '23505'

const plugin: FastifyPluginAsync = async app => {
	const { db, secrets } = app

	const findByEmail = (email: string) => db.users.findByEmail(normalizeEmail(email))

	app.decorate('userService', {
		get: async id => {
			const user = await db.users.get(id)
			if (!user) throw new EntityNotFound('user', id)
			return user
		},
		getOrg: async id => {
			const org = await db.users.getOrg(id)
			if (!org) throw new EntityNotFound('org', id)
			return org
		},
		findByEmail,
		findOrCreateByEmail: async email => {
			const existing = await findByEmail(email)
			if (existing) return existing

			const normalized = normalizeEmail(email)
			const [error, created] = await tryCatch(
				db.users.insertWithOrg(
					{
						email: normalized,
						role: isAdminEmail(normalized, secrets.authAdminEmails) ? 'admin' : 'user',
					},
					{ name: orgNameFromEmail(normalized) }
				)
			)
			if (!error) return created
			// Two first sign-ins for the same email raced (two magic links, a retried verify):
			// the other one won, so return what it created
			if (!isUniqueViolation(error)) throw error
			const winner = await findByEmail(normalized)
			if (!winner) throw error
			return winner
		},
	})
}

export default fp(plugin, {
	name: '#internal/userService',
	dependencies: ['#internal/db', '#internal/secrets'],
})
