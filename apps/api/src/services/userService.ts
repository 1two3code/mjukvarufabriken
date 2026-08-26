import fp from 'fastify-plugin'

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
			const org = await db.users.insertOrg({ name: orgNameFromEmail(normalized) })
			return db.users.insert({
				email: normalized,
				role: isAdminEmail(normalized, secrets.authAdminEmails) ? 'admin' : 'user',
				orgId: org.id,
			})
		},
	})
}

export default fp(plugin, {
	name: '#internal/userService',
	dependencies: ['#internal/db', '#internal/secrets'],
})
