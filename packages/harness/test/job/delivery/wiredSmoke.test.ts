import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	bootAndHold,
	createWiredSmokeCheck,
	extractApiCalls,
	extractFrontendApiSurface,
	parseViteApiBase,
	probeApiSurface,
	readEnvValue,
	wiredSmokeReason,
	wiringFailures,
} from '#job/delivery/wiredSmoke.ts'

import type { HeldServer } from '#job/delivery/wiredSmoke.ts'
import type { Server } from 'node:http'

// MARK: pure helpers

describe('readEnvValue', () => {
	it('reads the last assignment, trimming quotes and comments', () => {
		expect(readEnvValue('VITE_API_URL=/bff\n', 'VITE_API_URL')).toBe('/bff')
		expect(readEnvValue('# VITE_API_URL=/nope\nVITE_API_URL="/bff"\n', 'VITE_API_URL')).toBe('/bff')
		expect(readEnvValue('OTHER=1\n', 'VITE_API_URL')).toBeUndefined()
		expect(readEnvValue(undefined, 'VITE_API_URL')).toBeUndefined()
	})
})

describe('parseViteApiBase', () => {
	it('keeps a relative base, dropping a trailing slash', () => {
		expect(parseViteApiBase('/bff')).toBe('/bff')
		expect(parseViteApiBase('/bff/')).toBe('/bff')
	})
	it('reduces an absolute URL to its path', () => {
		expect(parseViteApiBase('http://localhost:5174/bff')).toBe('/bff')
	})
	it('maps root and empty to no prefix / undefined', () => {
		expect(parseViteApiBase('/')).toBe('')
		expect(parseViteApiBase('')).toBeUndefined()
		expect(parseViteApiBase(undefined)).toBeUndefined()
	})
})

describe('extractApiCalls', () => {
	it('pulls GET arrow and POST object endpoints', () => {
		const source = `
			list: builder.query({ query: () => '/guestbook' }),
			create: builder.mutation({ query: body => ({ url: '/guestbook', method: 'POST', body }) }),
		`
		expect(extractApiCalls(source)).toEqual([
			{ method: 'GET', path: '/guestbook' },
			{ method: 'POST', path: '/guestbook' },
		])
	})

	it('skips interpolated, concatenated and collection-prefix paths', () => {
		const source = `
			one: builder.query({ query: id => \`/items/\${id}\` }),
			two: builder.query({ query: id => ({ url: '/items/' + id }) }),
			three: builder.query({ query: () => '/items/' }),
			ok: builder.query({ query: () => '/items' }),
		`
		expect(extractApiCalls(source)).toEqual([{ method: 'GET', path: '/items' }])
	})

	it('dedupes repeated calls', () => {
		const source = `query: () => '/a'\nquery: () => '/a'`
		expect(extractApiCalls(source)).toEqual([{ method: 'GET', path: '/a' }])
	})
})

describe('wiringFailures / wiredSmokeReason', () => {
	it('flags only 404s and names them', () => {
		const failures = wiringFailures([
			{ method: 'GET', path: '/guestbook', status: 404 },
			{ method: 'POST', path: '/guestbook', status: 401 },
			{ method: 'GET', path: '/ok', status: 200 },
			{ method: 'GET', path: '/dead', status: 0 },
		])
		expect(failures).toEqual([{ method: 'GET', path: '/guestbook', status: 404 }])
		expect(wiredSmokeReason('/bff', failures)).toContain('GET /bff/guestbook')
		expect(wiredSmokeReason('/bff', failures)).toContain('VITE_API_URL=/bff')
	})
})

// MARK: filesystem extraction

describe('extractFrontendApiSurface', () => {
	let root: string
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mf-wired-'))
		await mkdir(join(root, 'apps', 'app', 'src', 'store'), { recursive: true })
		await writeFile(join(root, 'apps', 'app', 'index.html'), '<div id=root></div>')
		await writeFile(join(root, 'apps', 'app', '.env'), 'VITE_API_URL=/bff\n')
		await writeFile(
			join(root, 'apps', 'app', 'src', 'store', 'guestbookApi.ts'),
			`import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'
			 export const api = createApi({ baseQuery: fetchBaseQuery({ baseUrl: import.meta.env.VITE_API_URL }),
			   endpoints: b => ({
			     list: b.query({ query: () => '/guestbook' }),
			     create: b.mutation({ query: body => ({ url: '/guestbook', method: 'POST', body }) }),
			   }) })`
		)
	})
	afterEach(() => rm(root, { recursive: true, force: true }))

	it('reads VITE_API_URL and the RTK slice calls', async () => {
		const surface = await extractFrontendApiSurface(root)
		expect(surface).toEqual({
			base: '/bff',
			calls: [
				{ method: 'GET', path: '/guestbook' },
				{ method: 'POST', path: '/guestbook' },
			],
		})
	})

	it('.env.live overrides .env for the delivered (live) build', async () => {
		await writeFile(join(root, 'apps', 'app', '.env.live'), 'VITE_API_URL=/api\n')
		expect((await extractFrontendApiSurface(root))?.base).toBe('/api')
	})

	it('returns undefined when there is no SPA', async () => {
		const empty = await mkdtemp(join(tmpdir(), 'mf-nospa-'))
		expect(await extractFrontendApiSurface(empty)).toBeUndefined()
		await rm(empty, { recursive: true, force: true })
	})
})

// MARK: probe against a real server

describe('probeApiSurface (real http)', () => {
	let server: Server
	let origin: string
	beforeEach(async () => {
		// The mismatch: the SPA calls /bff/guestbook, but the backend only serves /guestbook.
		server = createServer((req, res) => {
			res.statusCode = req.url === '/guestbook' ? 200 : 404
			res.end()
		})
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
		const address = server.address()
		origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
	})
	afterEach(() => new Promise<void>(resolve => server.close(() => resolve())))

	it('reports the 404 the SPA would hit at /bff/guestbook', async () => {
		const results = await probeApiSurface(
			origin,
			{ base: '/bff', calls: [{ method: 'GET', path: '/guestbook' }] },
			fetch
		)
		expect(results).toEqual([{ method: 'GET', path: '/guestbook', status: 404 }])
		expect(wiringFailures(results)).toHaveLength(1)
	})

	it('passes when the backend serves the SPA base (no /bff prefix here)', async () => {
		const results = await probeApiSurface(
			origin,
			{ base: '', calls: [{ method: 'GET', path: '/guestbook' }] },
			fetch
		)
		expect(wiringFailures(results)).toEqual([])
	})
})

// MARK: the BootCheck end to end (injected boot, real http server)

describe('createWiredSmokeCheck', () => {
	let root: string
	let server: Server
	let origin: string
	let killed: number

	const seedRepo = async (viteApiUrl: string) => {
		await mkdir(join(root, 'apps', 'api', 'src'), { recursive: true })
		await writeFile(join(root, 'apps', 'api', 'src', 'index.ts'), '// server entry')
		await mkdir(join(root, 'apps', 'app', 'src'), { recursive: true })
		await writeFile(join(root, 'apps', 'app', 'index.html'), '<div id=root></div>')
		await writeFile(join(root, 'apps', 'app', '.env'), `VITE_API_URL=${viteApiUrl}\n`)
		await writeFile(
			join(root, 'apps', 'app', 'src', 'api.ts'),
			`import { createApi } from '@reduxjs/toolkit/query/react'
			 createApi({ endpoints: b => ({ list: b.query({ query: () => '/guestbook' }) }) })`
		)
	}

	const fakeBoot = async (): Promise<HeldServer> => ({
		ok: true,
		output: 'Server listening',
		origin,
		kill: () => {
			killed++
		},
	})

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mf-wiredcheck-'))
		killed = 0
		server = createServer((req, res) => {
			res.statusCode = req.url === '/guestbook' ? 200 : 404 // backend serves /guestbook, not /bff/guestbook
			res.end()
		})
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
		const address = server.address()
		origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
	})
	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
		await new Promise<void>(resolve => server.close(() => resolve()))
	})

	it('fails when the SPA base (/bff) does not match the served routes, and kills the server', async () => {
		await seedRepo('/bff')
		const check = createWiredSmokeCheck({ bootFn: fakeBoot })
		const result = await check.boot({ repoDir: root, env: {} })
		expect(result.ok).toBe(false)
		expect(result.reason).toContain('GET /bff/guestbook')
		expect(killed).toBe(1)
	})

	it('passes when the SPA base matches the served routes', async () => {
		await seedRepo('/') // SPA calls /guestbook, which the server serves
		const check = createWiredSmokeCheck({ bootFn: fakeBoot })
		const result = await check.boot({ repoDir: root, env: {} })
		expect(result.ok).toBe(true)
		expect(killed).toBe(1)
	})

	it('passes through a boot failure without probing', async () => {
		await seedRepo('/bff')
		const check = createWiredSmokeCheck({
			bootFn: async () => ({ ok: false, output: 'boom', reason: 'server exited (code 1)' }),
		})
		const result = await check.boot({ repoDir: root, env: {} })
		expect(result).toEqual({ ok: false, output: 'boom', reason: 'server exited (code 1)' })
	})

	it('is a pass when there is no server entry (static delivery)', async () => {
		const check = createWiredSmokeCheck({ bootFn: fakeBoot })
		const result = await check.boot({ repoDir: root, env: {} })
		expect(result.ok).toBe(true)
		expect(result.reason).toContain('static delivery')
	})

	// bootAndHold is exported for the real delivery path; a shape assertion documents the seam.
	it('exposes bootAndHold', () => {
		expect(typeof bootAndHold).toBe('function')
	})
})
