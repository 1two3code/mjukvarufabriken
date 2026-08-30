import fp from 'fastify-plugin'
import { mergeDeep } from '@mf/utils/object'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { PartialDeep } from 'type-fest'
import type { Org, User } from '@mf/models'

const defaultOrg: Org = {
	id: 'org-1',
	name: 'planetexpress.example',
	createdAt: '2025-01-01T00:00:00.000Z',
}

const defaultUser: User = {
	id: 'user-1',
	email: 'farnsworth@planetexpress.example',
	name: 'Hubert J. Farnsworth',
	role: 'user',
	orgId: defaultOrg.id,
	createdAt: '2025-01-01T00:00:00.000Z',
}

export const createMockOrg = (overrides?: PartialDeep<Org>) => mergeDeep(defaultOrg, overrides)
export const createMockUser = (overrides?: PartialDeep<User>) => mergeDeep(defaultUser, overrides)

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['userService'] = {
		get: vi.fn((id: string) => Promise.resolve(createMockUser({ id }))),
		getOrg: vi.fn((id: string) => Promise.resolve(createMockOrg({ id }))),
		findByEmail: vi.fn().mockResolvedValue(undefined),
		findOrCreateByEmail: vi.fn((email: string) => Promise.resolve(createMockUser({ email }))),
	}

	app.decorate('userService', mock)
}

export default fp(mockPlugin, { name: '#internal/userService' })
