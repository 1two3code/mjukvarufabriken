import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import autoload from '@fastify/autoload'

import { createServer } from './server.ts'

import type { LogLevel } from 'fastify'

const { ADDRESS = 'localhost', PORT = '5174' } = process.env

const logLevel = process.env.LOG_LEVEL as LogLevel
const server = await createServer({ logLevel })

// Register routes
server.register(autoload, {
	dir: join(dirname(fileURLToPath(import.meta.url)), 'routes'),
	dirNameRoutePrefix: false,
	ignorePattern: /^.*(?:types|utils).ts$/,
})

// Register health check endpoint
server.get('/health', { logLevel: 'silent' }, async () => ({ message: 'OK' }))

try {
	await server.listen({ host: ADDRESS, port: Number(PORT) })
} catch (err) {
	server.log.fatal(err)
	process.exit(1)
}
