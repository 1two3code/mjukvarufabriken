import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import autoload from '@fastify/autoload'

import { registerSpa } from '#/lib/spa.ts'
import { createServer } from './server.ts'

import type { LogLevel } from 'fastify'

const { ADDRESS = 'localhost', PORT = '5174', SPA_DIR } = process.env

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

// Single-container delivery: this service also serves the built SPA at "/" so the deployed
// URL shows the website. Headless (no SPA_DIR) for local dev and our CDN-fronted deploy.
if (SPA_DIR) await registerSpa(server, SPA_DIR)

try {
	await server.listen({ host: ADDRESS, port: Number(PORT) })
} catch (err) {
	server.log.fatal(err)
	process.exit(1)
}
