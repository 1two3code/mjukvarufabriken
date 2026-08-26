import fp from 'fastify-plugin'

import type { FastifyPluginAsync } from 'fastify'

const mockPlugin: FastifyPluginAsync = async () => {}

export default fp(mockPlugin, { name: '#internal/accessControl' })
