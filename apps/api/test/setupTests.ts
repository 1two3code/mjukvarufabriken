import { createAppMock } from './appMock.ts'
import { createNetworkMock } from './networkMock.ts'

import type { NetworkMock } from './networkMock.ts'

declare global {
	/**
	 * Global function for creating a mock Fastify instance
	 */
	const createTestApp: typeof createAppMock

	/**
	 * Global testing variable for mocking endpoints
	 */
	const networkMock: NetworkMock
}

// Bind Fastify instances mocking factory
vi.stubGlobal('createTestApp', createAppMock)

// Create a mock network server for mocking endpoints
const { networkServer, networkMock } = createNetworkMock()
vi.stubGlobal('networkMock', networkMock)

beforeAll(async () => {
	networkServer.listen({ onUnhandledRequest: 'bypass' })
})

afterAll(() => {
	networkServer.close()
})

afterEach(() => {
	networkServer.resetHandlers()
	networkMock.reset()
})
