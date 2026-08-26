import fp from 'fastify-plugin'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { ContactMessage } from '#/services/contactService.ts'

export const createMockContactMessage = (overrides?: Partial<ContactMessage>): ContactMessage => ({
	name: 'Anna Andersson',
	email: 'anna@acme.se',
	company: 'Acme AB',
	message: 'Vi vill bygga ett bokningssystem för våra kurser.',
	...overrides,
})

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['contactService'] = {
		submit: vi.fn().mockResolvedValue('sent'),
	}

	app.decorate('contactService', mock)
}

export default fp(mockPlugin, { name: '#internal/contactService' })
