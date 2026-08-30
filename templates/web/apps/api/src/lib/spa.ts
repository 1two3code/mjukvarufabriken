import { existsSync } from 'node:fs'
import { join } from 'node:path'

import fastifyStatic from '@fastify/static'

import type { FastifyInstance } from 'fastify'

/**
 * Serve a built single-page app from [spaDir] when one is present: static files from disk,
 * plus a client-side-routing fallback to index.html for any non-API GET that isn't a real
 * file. Used by single-container delivery (ECS Express) so the deployed URL serves the actual
 * website while this same server keeps handling /bff. No-op (returns false) when there is no
 * build at [spaDir]. Call after the API routes are registered.
 */
export async function registerSpa(server: FastifyInstance, spaDir: string): Promise<boolean> {
	if (!existsSync(join(spaDir, 'index.html'))) return false

	await server.register(fastifyStatic, { root: spaDir, wildcard: false })

	server.setNotFoundHandler((request, reply) => {
		const wantsApp =
			request.method === 'GET' &&
			!request.url.startsWith('/bff') &&
			!request.url.startsWith('/health')
		if (wantsApp) return reply.sendFile('index.html')
		return reply.code(404).send({ message: 'Not Found' })
	})

	return true
}
