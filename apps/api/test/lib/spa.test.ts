import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fastify } from 'fastify'

import { registerSpa } from '#/lib/spa.ts'

import type { FastifyInstance } from 'fastify'

const INDEX_HTML = '<!doctype html><html><body>hello spa</body></html>'

describe('registerSpa', () => {
	let dir: string
	let app: FastifyInstance

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'spa-'))
		app = fastify()
		app.get('/bff/ping', async () => ({ ok: true }))
	})

	afterEach(async () => {
		await app.close()
		rmSync(dir, { recursive: true, force: true })
	})

	it('is a no-op (returns false) when there is no build', async () => {
		expect(await registerSpa(app, dir)).toBe(false)
		expect((await app.inject({ url: '/' })).statusCode).toBe(404)
	})

	it('serves index.html at the root when a build is present', async () => {
		writeFileSync(join(dir, 'index.html'), INDEX_HTML)
		expect(await registerSpa(app, dir)).toBe(true)
		const res = await app.inject({ url: '/' })
		expect(res.statusCode).toBe(200)
		expect(res.body).toContain('hello spa')
	})

	it('serves real static assets from disk', async () => {
		writeFileSync(join(dir, 'index.html'), INDEX_HTML)
		mkdirSync(join(dir, 'assets'))
		writeFileSync(join(dir, 'assets', 'app.js'), 'console.log("app")')
		await registerSpa(app, dir)
		const res = await app.inject({ url: '/assets/app.js' })
		expect(res.statusCode).toBe(200)
		expect(res.body).toContain('console.log')
	})

	it('falls back to index.html for client-side routes (deep GET)', async () => {
		writeFileSync(join(dir, 'index.html'), INDEX_HTML)
		await registerSpa(app, dir)
		const res = await app.inject({ url: '/some/deep/client/route' })
		expect(res.statusCode).toBe(200)
		expect(res.body).toContain('hello spa')
	})

	it('does not shadow API routes and 404s unknown /bff paths without serving the SPA', async () => {
		writeFileSync(join(dir, 'index.html'), INDEX_HTML)
		await registerSpa(app, dir)
		const ok = await app.inject({ url: '/bff/ping' })
		expect(ok.statusCode).toBe(200)
		expect(ok.json()).toEqual({ ok: true })
		const missing = await app.inject({ url: '/bff/nope' })
		expect(missing.statusCode).toBe(404)
		expect(missing.body).not.toContain('hello spa')
	})
})
