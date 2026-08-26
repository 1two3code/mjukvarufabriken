import fp from 'fastify-plugin'

import type { FastifyPluginAsync } from 'fastify'
import type { RequestToken } from '#/plugins/auth.ts'

const date = new Date()
const iat = Math.round(date.getTime() / 1000)
const exp = Math.round(date.setHours(date.getHours() + 2) / 1000)

const decodedToken: Omit<RequestToken, 'encoded'> = {
	sub: 'user-1',
	name: 'Hubert J. Farnsworth',
	role: 'user',
	iss: 'https://auth.example.com',
	aud: 'mjukvarufabriken',
	exp,
	iat,
}

export const getMockToken = (): RequestToken => ({ ...decodedToken, encoded: 'encodedToken' })

const mockPlugin: FastifyPluginAsync = async app => {
	app.decorateRequest('token')
	app.decorateRequest('session')

	app.addHook('onRequest', async request => {
		request.token = getMockToken()
		request.session = { userId: decodedToken.sub, role: decodedToken.role }
	})
}

export default fp(mockPlugin, { name: '#internal/auth' })
