import fp from 'fastify-plugin'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { TokenPair } from '@mf/models'

export const createMockTokenPair = (overrides?: Partial<TokenPair>): TokenPair => ({
	token: 'access-token',
	refreshToken: 'refresh-token',
	...overrides,
})

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['authService'] = {
		requestMagicLink: vi.fn().mockResolvedValue(undefined),
		verifyMagicLink: vi.fn().mockResolvedValue(createMockTokenPair()),
		refresh: vi.fn().mockResolvedValue(createMockTokenPair()),
		logout: vi.fn().mockResolvedValue(undefined),
	}

	app.decorate('authService', mock)
}

export default fp(mockPlugin, { name: '#internal/authService' })
