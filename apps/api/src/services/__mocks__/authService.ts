import fp from 'fastify-plugin'

import { createMockUser } from '#/services/__mocks__/userService.ts'

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
		signInWithGithub: vi
			.fn()
			.mockResolvedValue(createMockUser({ githubId: '4242', githubLogin: 'leela' })),
		createLoginLink: vi
			.fn()
			.mockResolvedValue('https://portal.example.com/auth/callback?token=login-token'),
	}

	app.decorate('authService', mock)
}

export default fp(mockPlugin, { name: '#internal/authService' })
