import fp from 'fastify-plugin'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { GithubProfile } from '#/plugins/githubOAuth.ts'

export const mockAuthorizeUrl = 'https://github.com/login/oauth/authorize?client_id=gh-client-id'

export const createMockGithubProfile = (overrides?: Partial<GithubProfile>): GithubProfile => ({
	id: '4242',
	login: 'leela',
	name: 'Turanga Leela',
	email: 'leela@planetexpress.example',
	...overrides,
})

/** Clearly a fake: never talks to GitHub. Tests override `fetchProfile` per case. */
const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['githubOauth'] = {
		configured: true,
		authorizeUrl: vi.fn(({ state }: { state: string }) => `${mockAuthorizeUrl}&state=${state}`),
		fetchProfile: vi.fn().mockResolvedValue(createMockGithubProfile()),
	}

	app.decorate('githubOauth', mock)
}

export default fp(mockPlugin, { name: '#internal/githubOauth' })
