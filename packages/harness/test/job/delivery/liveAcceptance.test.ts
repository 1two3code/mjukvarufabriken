import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	createFakeLiveCheck,
	createLiveAcceptanceCheck,
	extractAssetPaths,
	renderPageInChild,
} from '#job/delivery/liveAcceptance.ts'

import type { LiveFetch, PageRenderer } from '#job/delivery/liveAcceptance.ts'

const LIVE = 'https://mf-11111111-app.eu-north-1.on.aws'

const html = `<!doctype html><html><body><div id="root"></div><script src="/assets/index-abc.js"></script></body></html>`

/** One route table → a LiveFetch: `${method} ${path}` → status (unlisted → 404) */
const fakeFetch = (routes: Record<string, number | ((token?: string) => number)>): LiveFetch =>
	async (url, init) => {
		const path = url.replace(LIVE, '') || '/'
		const token = init.headers?.authorization?.replace('Bearer ', '')
		const entry = routes[`${init.method} ${path}`]
		const status = typeof entry === 'function' ? entry(token) : (entry ?? 404)
		return { status, text: async () => (path === '/' ? html : 'ok') }
	}

const renderOk: PageRenderer = async () => ({ rootHtml: '<main>Hello</main>', errors: [] })

/** A delivered-repo fixture: SPA with VITE_API_URL=/bff + one RTK slice + the auth allowlist */
const seedRepo = async (
	root: string,
	{ publicUrls = [] as string[], calls = `list: b.query({ query: () => '/guestbook' })` } = {}
) => {
	await mkdir(join(root, 'apps', 'app', 'src'), { recursive: true })
	await writeFile(join(root, 'apps', 'app', 'index.html'), '<div id=root></div>')
	await writeFile(join(root, 'apps', 'app', '.env'), 'VITE_API_URL=/bff\n')
	await writeFile(
		join(root, 'apps', 'app', 'src', 'api.ts'),
		`import { createApi } from '@reduxjs/toolkit/query/react'
		 createApi({ endpoints: b => ({ ${calls} }) })`
	)
	await mkdir(join(root, 'apps', 'api', 'src', 'plugins'), { recursive: true })
	await writeFile(
		join(root, 'apps', 'api', 'src', 'plugins', 'auth.ts'),
		`const publicUrls = new Set([${publicUrls.map(url => `'${url}'`).join(', ')}])`
	)
}

describe('extractAssetPaths', () => {
	it('finds the referenced bundle and stylesheet paths', () => {
		expect(
			extractAssetPaths(
				'<script src="/assets/index-abc.js"></script><link href="/assets/index-def.css">'
			)
		).toEqual(['/assets/index-abc.js', '/assets/index-def.css'])
	})
})

describe('createLiveAcceptanceCheck', () => {
	let root: string
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mf-live-'))
	})
	afterEach(() => rm(root, { recursive: true, force: true }))

	it('passes a working app: HTML + asset + render + a public 200 route', async () => {
		await seedRepo(root, { publicUrls: ['/bff/guestbook'] })
		const check = createLiveAcceptanceCheck({
			fetchFn: fakeFetch({ 'GET /': 200, 'GET /assets/index-abc.js': 200, 'GET /bff/guestbook': 200 }),
			render: renderOk,
		})
		const result = await check.check({ url: LIVE, repoDir: root })
		expect(result.reason).toBeUndefined()
		expect(result.ok).toBe(true)
		expect(result.probes).toEqual([
			{ method: 'GET', path: '/guestbook', status: 200, ok: true },
		])
		expect(result.renderedChars).toBeGreaterThan(0)
	})

	it('GUESTBOOK REGRESSION: an unauthed 401 route with empty publicUrls fails — and the minted token diagnoses it as auth-gated', async () => {
		await seedRepo(root, { publicUrls: [] })
		const check = createLiveAcceptanceCheck({
			fetchFn: fakeFetch({
				'GET /': 200,
				'GET /assets/index-abc.js': 200,
				'GET /bff/guestbook': token => (token === 'preview-token' ? 200 : 401),
			}),
			render: renderOk,
			mintToken: async () => 'preview-token',
		})
		const result = await check.check({ url: LIVE, repoDir: root })
		expect(result.ok).toBe(false)
		expect(result.reason).toContain('publicUrls')
		expect(result.probes[0]).toMatchObject({ status: 401, tokenStatus: 200, ok: false })
		expect(result.probes[0]!.reason).toContain('only for authenticated users')
	})

	it('a route that fails even WITH a valid token says so', async () => {
		await seedRepo(root)
		const check = createLiveAcceptanceCheck({
			fetchFn: fakeFetch({ 'GET /': 200, 'GET /assets/index-abc.js': 200, 'GET /bff/guestbook': () => 401 }),
			render: renderOk,
			mintToken: async () => 'preview-token',
		})
		const result = await check.check({ url: LIVE, repoDir: root })
		expect(result.ok).toBe(false)
		expect(result.probes[0]!.reason).toContain('broken even with valid auth')
	})

	it('treats 5xx as failure (dead database), never as "route exists"', async () => {
		await seedRepo(root, { publicUrls: ['/bff/guestbook'] })
		const check = createLiveAcceptanceCheck({
			fetchFn: fakeFetch({ 'GET /': 200, 'GET /assets/index-abc.js': 200, 'GET /bff/guestbook': 500 }),
			render: renderOk,
		})
		const result = await check.check({ url: LIVE, repoDir: root })
		expect(result.ok).toBe(false)
		expect(result.reason).toContain('broken')
	})

	it('fails closed when the probe surface is undiscoverable (no VITE_API_URL)', async () => {
		await mkdir(join(root, 'apps', 'app'), { recursive: true })
		await writeFile(join(root, 'apps', 'app', 'index.html'), '<div id=root></div>')
		const check = createLiveAcceptanceCheck({
			fetchFn: fakeFetch({ 'GET /': 200, 'GET /assets/index-abc.js': 200 }),
			render: renderOk,
		})
		const result = await check.check({ url: LIVE, repoDir: root })
		expect(result.ok).toBe(false)
		expect(result.reason).toContain('undiscoverable')
	})

	it('fails closed when the extracted probe set is empty', async () => {
		await seedRepo(root, { calls: `one: b.query({ query: id => \`/items/\${id}\` })` })
		const check = createLiveAcceptanceCheck({
			fetchFn: fakeFetch({ 'GET /': 200, 'GET /assets/index-abc.js': 200 }),
			render: renderOk,
		})
		const result = await check.check({ url: LIVE, repoDir: root })
		expect(result.ok).toBe(false)
		expect(result.reason).toContain('empty')
	})

	it('fails on a blank render and on console errors', async () => {
		await seedRepo(root, { publicUrls: ['/bff/guestbook'] })
		const routes = { 'GET /': 200, 'GET /assets/index-abc.js': 200, 'GET /bff/guestbook': 200 }
		const blank = await createLiveAcceptanceCheck({
			fetchFn: fakeFetch(routes),
			render: async () => ({ rootHtml: '  ', errors: [] }),
		}).check({ url: LIVE, repoDir: root })
		expect(blank.ok).toBe(false)
		expect(blank.reason).toContain('blank page')

		const errored = await createLiveAcceptanceCheck({
			fetchFn: fakeFetch(routes),
			render: async () => ({ rootHtml: '<main/>', errors: ['Uncaught TypeError: x is undefined'] }),
		}).check({ url: LIVE, repoDir: root })
		expect(errored.ok).toBe(false)
		expect(errored.reason).toContain('console errors')
	})

	it('fails when the landing page or its bundle asset is not served', async () => {
		await seedRepo(root, { publicUrls: ['/bff/guestbook'] })
		const noPage = await createLiveAcceptanceCheck({
			fetchFn: fakeFetch({ 'GET /bff/guestbook': 200 }),
			render: renderOk,
		}).check({ url: LIVE, repoDir: root })
		expect(noPage.ok).toBe(false)
		expect(noPage.reason).toContain('GET / → 404')

		const noAsset = await createLiveAcceptanceCheck({
			fetchFn: fakeFetch({ 'GET /': 200, 'GET /bff/guestbook': 200 }),
			render: renderOk,
		}).check({ url: LIVE, repoDir: root })
		expect(noAsset.ok).toBe(false)
		expect(noAsset.reason).toContain('/assets/index-abc.js')
	})

	it('never judges the template auth-bootstrap routes', async () => {
		await seedRepo(root, {
			publicUrls: ['/bff/guestbook'],
			calls: `list: b.query({ query: () => '/guestbook' }), session: b.query({ query: () => '/session' })`,
		})
		const check = createLiveAcceptanceCheck({
			fetchFn: fakeFetch({
				'GET /': 200,
				'GET /assets/index-abc.js': 200,
				'GET /bff/guestbook': 200,
				'GET /bff/session': 401,
			}),
			render: renderOk,
		})
		const result = await check.check({ url: LIVE, repoDir: root })
		expect(result.ok).toBe(true)
	})
})

describe('createFakeLiveCheck', () => {
	it('records its inputs and returns the canned result', async () => {
		const fake = createFakeLiveCheck({ ok: false, reason: 'nope', probes: [] })
		const result = await fake.check({ url: LIVE, repoDir: '/repo' })
		expect(result.ok).toBe(false)
		expect(fake.calls).toEqual([{ url: LIVE, repoDir: '/repo' }])
	})
})

// MARK: the real jsdom child renderer, against a local server (no network)

describe('renderPageInChild (real jsdom child process)', () => {
	const serve = (app: string) => {
		const page = `<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>`
		const server = createServer((request, response) => {
			if (request.url === '/app.js') {
				response.writeHead(200, { 'content-type': 'text/javascript' })
				response.end(app)
				return
			}
			response.writeHead(200, { 'content-type': 'text/html' })
			response.end(page)
		})
		return new Promise<{ origin: string; close: () => void }>(resolve =>
			server.listen(0, '127.0.0.1', () => {
				const address = server.address()
				resolve({
					origin: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
					close: () => server.close(),
				})
			})
		)
	}

	it('renders a working bundle into #root with no errors', async () => {
		const { origin, close } = await serve(
			`document.getElementById('root').innerHTML = '<main>Hello live</main>'`
		)
		try {
			const page = await renderPageInChild(`${origin}/`)
			expect(page.reason).toBeUndefined()
			expect(page.errors).toEqual([])
			expect(page.rootHtml).toContain('Hello live')
		} finally {
			close()
		}
	}, 60_000)

	it('reports a crashing bundle as console errors with a blank root', async () => {
		const { origin, close } = await serve(`throw new TypeError('bundle is broken')`)
		try {
			const page = await renderPageInChild(`${origin}/`)
			expect(page.rootHtml.trim()).toBe('')
			expect(page.errors.join(' ')).toContain('TypeError')
		} finally {
			close()
		}
	}, 60_000)
})
