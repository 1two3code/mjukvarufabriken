import fp from 'fastify-plugin'

import { EntityNotFound } from '#/lib/entityError.ts'
import { storeCollections } from '#/plugins/store.ts'
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
	const { store, secrets } = app

	const findByEmail = async (email: string) => {
		const normalized = normalizeEmail(email)
		const users = await store.list<User>(storeCollections.users)
		return users.find(user => user.email === normalized)
	}

	const createOrg = async (name: string) => {
		const org: Org = { id: crypto.randomUUID(), name, createdAt: new Date().toISOString() }
		await store.put(storeCollections.orgs, org.id, org)
		return org
	}

	app.decorate('userService', {
		get: async id => {
			const user = await store.get<User>(storeCollections.users, id)
			if (!user) throw new EntityNotFound('user', id)
			return user
		},
		getOrg: async id => {
			const org = await store.get<Org>(storeCollections.orgs, id)
			if (!org) throw new EntityNotFound('org', id)
			return org
		},
		findByEmail,
		findOrCreateByEmail: async email => {
			const existing = await findByEmail(email)
			if (existing) return existing

			const normalized = normalizeEmail(email)
			const org = await createOrg(orgNameFromEmail(normalized))
			const user: User = {
				id: crypto.randomUUID(),
				email: normalized,
				role: isAdminEmail(normalized, secrets.authAdminEmails) ? 'admin' : 'user',
				orgId: org.id,
				createdAt: new Date().toISOString(),
			}
			await store.put(storeCollections.users, user.id, user)
			return user
		},
	})
}

export default fp(plugin, {
	name: '#internal/userService',
	dependencies: ['#internal/store', '#internal/secrets'],
})
