import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	createFakeLiveCheck,
	createLiveAcceptanceCheck,
	extractAssetPaths,
	hasBuiltByFooter,
	renderPageInChild,
} from '#job/delivery/liveAcceptance.ts'

import type { spawn } from 'node:child_process'

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

	it('READINESS: retries a landing 503/refused-connection until the fresh service answers, then passes', async () => {
		await seedRepo(root, { publicUrls: ['/bff/guestbook'] })
		const okFetch = fakeFetch({ 'GET /': 200, 'GET /assets/index-abc.js': 200, 'GET /bff/guestbook': 200 })
		let landingAttempts = 0
		const warmingFetch: LiveFetch = async (url, init) => {
			if (url === `${LIVE}/` && init.method === 'GET') {
				landingAttempts += 1
				if (landingAttempts === 1) throw new Error('ECONNREFUSED') // no task behind the endpoint yet
				if (landingAttempts === 2) return { status: 503, text: async () => 'warming up' }
			}
			return okFetch(url, init)
		}
		const sleeps: number[] = []
		const check = createLiveAcceptanceCheck({
			fetchFn: warmingFetch,
			render: renderOk,
			readinessIntervalMs: 5_000,
			sleep: async ms => void sleeps.push(ms),
		})
		const result = await check.check({ url: LIVE, repoDir: root })
		expect(result.ok).toBe(true)
		expect(landingAttempts).toBe(3)
		expect(sleeps).toEqual([5_000, 5_000])
	})

	it('READINESS: gives up at the deadline and judges the final failing answer', async () => {
		await seedRepo(root, { publicUrls: ['/bff/guestbook'] })
		let landingAttempts = 0
		const deadFetch: LiveFetch = async (url, init) => {
			if (url === `${LIVE}/` && init.method === 'GET') landingAttempts += 1
			return { status: 503, text: async () => 'no' }
		}
		let clock = 0
		const check = createLiveAcceptanceCheck({
			fetchFn: deadFetch,
			render: renderOk,
			readinessTimeoutMs: 60_000,
			readinessIntervalMs: 10_000,
			sleep: async ms => void (clock += ms),
			now: () => clock,
		})
		const result = await check.check({ url: LIVE, repoDir: root })
		expect(result.ok).toBe(false)
		expect(result.reason).toContain('GET / → 503')
		expect(landingAttempts).toBe(7) // the first try + one per 10 s of the 60 s window
	})

	it('READINESS: never retries a 4xx — that is the app answering wrongly, not warming up', async () => {
		await seedRepo(root, { publicUrls: ['/bff/guestbook'] })
		let landingAttempts = 0
		const notFoundFetch: LiveFetch = async (url, init) => {
			if (url === `${LIVE}/` && init.method === 'GET') landingAttempts += 1
			return { status: 404, text: async () => 'no' }
		}
		const sleeps: number[] = []
		const check = createLiveAcceptanceCheck({
			fetchFn: notFoundFetch,
			render: renderOk,
			sleep: async ms => void sleeps.push(ms),
		})
		const result = await check.check({ url: LIVE, repoDir: root })
		expect(result.ok).toBe(false)
		expect(landingAttempts).toBe(1)
		expect(sleeps).toEqual([])
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

// MARK: the "Built by Mjukvaruhuset" footer — information on the result, never a verdict (F5)

describe('hasBuiltByFooter', () => {
	it('recognises the template footer link in rendered markup, with or without a path', () => {
		expect(
			hasBuiltByFooter(
				'<footer><a class="x" href="https://mjukvaruhuset.se" target="_blank">Byggd av Mjukvaruhuset</a></footer>'
			)
		).toBe(true)
		expect(hasBuiltByFooter('<a href="https://www.mjukvaruhuset.se/?ref=app">Built by</a>')).toBe(true)
		expect(hasBuiltByFooter('<a href="http://mjukvaruhuset.se/demo">Built by</a>')).toBe(true)
	})

	it('does not count a bare mention, a foreign host or a look-alike domain', () => {
		expect(hasBuiltByFooter('<p>Built by Mjukvaruhuset</p>')).toBe(false)
		expect(hasBuiltByFooter('<a href="https://example.com">mjukvaruhuset.se</a>')).toBe(false)
		expect(hasBuiltByFooter('<a href="https://mjukvaruhuset.se.evil.com/">x</a>')).toBe(false)
		expect(hasBuiltByFooter('')).toBe(false)
	})
})

describe('createLiveAcceptanceCheck — builtByFooter', () => {
	let root: string
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mf-live-footer-'))
		await seedRepo(root, { publicUrls: ['/bff/guestbook'] })
	})
	afterEach(() => rm(root, { recursive: true, force: true }))

	const routes = { 'GET /': 200, 'GET /assets/index-abc.js': 200, 'GET /bff/guestbook': 200 }

	it('records true when the rendered page carries the footer link', async () => {
		const result = await createLiveAcceptanceCheck({
			fetchFn: fakeFetch(routes),
			render: async () => ({
				rootHtml:
					'<main>Hello</main><footer><a href="https://mjukvaruhuset.se" target="_blank" rel="noopener noreferrer">Byggd av Mjukvaruhuset — beställ din egen</a></footer>',
				errors: [],
			}),
		}).check({ url: LIVE, repoDir: root })
		expect(result.ok).toBe(true)
		expect(result.builtByFooter).toBe(true)
	})

	it('records false when the footer is gone — and still passes: information, not a verdict', async () => {
		const result = await createLiveAcceptanceCheck({
			fetchFn: fakeFetch(routes),
			render: renderOk,
		}).check({ url: LIVE, repoDir: root })
		expect(result.ok).toBe(true)
		expect(result.reason).toBeUndefined()
		expect(result.builtByFooter).toBe(false)
	})

	it('leaves the flag undefined when the render itself did not happen or failed', async () => {
		const noPage = await createLiveAcceptanceCheck({
			fetchFn: fakeFetch({ 'GET /bff/guestbook': 200 }),
			render: renderOk,
		}).check({ url: LIVE, repoDir: root })
		expect(noPage.builtByFooter).toBeUndefined()

		const crashed = await createLiveAcceptanceCheck({
			fetchFn: fakeFetch(routes),
			render: async () => ({ rootHtml: '', errors: [], reason: 'render process timed out' }),
		}).check({ url: LIVE, repoDir: root })
		expect(crashed.ok).toBe(false)
		expect(crashed.builtByFooter).toBeUndefined()
	})

	it('is also reported on a failing check (a broken app can still carry the footer)', async () => {
		const result = await createLiveAcceptanceCheck({
			fetchFn: fakeFetch({ ...routes, 'GET /bff/guestbook': 500 }),
			render: async () => ({
				rootHtml: '<footer><a href="https://mjukvaruhuset.se">Built by Mjukvaruhuset</a></footer>',
				errors: [],
			}),
		}).check({ url: LIVE, repoDir: root })
		expect(result.ok).toBe(false)
		expect(result.builtByFooter).toBe(true)
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

// MARK: the render child's sandbox (the delivered bundle is untrusted code)

describe('renderPageInChild sandbox', () => {
	it('spawns the jsdom child through the setpriv worker sandbox, like every other untrusted execution', async () => {
		const captured: { command: string; args: string[]; options: Record<string, unknown> }[] = []
		const fakeSpawn = ((command: string, args: string[], options: Record<string, unknown>) => {
			captured.push({ command, args, options })
			const child = new EventEmitter() as EventEmitter & {
				stdout: EventEmitter
				stderr: EventEmitter
				kill: () => void
				pid: number
			}
			child.stdout = new EventEmitter()
			child.stderr = new EventEmitter()
			child.kill = () => {}
			child.pid = 99999
			setImmediate(() => {
				child.stdout.emit('data', `${JSON.stringify({ rootHtml: '<main>ok</main>', errors: [] })}\n`)
				child.emit('close', 0)
			})
			return child
		}) as unknown as typeof spawn
		const user = { uid: 60001, gid: 60001, home: '/home/worker' }

		process.env.JOB_TOKEN = 'never-reaches-the-bundle'
		let page
		try {
			page = await renderPageInChild('http://127.0.0.1:1/', undefined, { spawnFn: fakeSpawn, user })
		} finally {
			delete process.env.JOB_TOKEN
		}

		expect(page.rootHtml).toContain('ok')
		expect(captured).toHaveLength(1)
		const call = captured[0]!
		// The whole point: setpriv drops to the worker uid with an EMPTY capability set — the
		// bundle must never run with the job's uid or its ambient CAP_SETUID/SETGID/KILL.
		expect(call.command).toBe('setpriv')
		expect(call.args.slice(0, 6)).toEqual([
			'--reuid=60001',
			'--regid=60001',
			'--init-groups',
			'--inh-caps=-all',
			'--ambient-caps=-all',
			'--no-new-privs',
		])
		expect(call.args).toContain(process.execPath)
		expect(call.args.at(-1)).toBe('http://127.0.0.1:1/')
		expect(call.args.find(arg => arg.includes('renderPage.script.ts'))).toBeDefined()
		// Worker env on top of the scrubbed sandbox env
		const env = call.options.env as Record<string, string | undefined>
		expect(env.HOME).toBe('/home/worker')
		expect(env.JOB_TOKEN).toBeUndefined()
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

// MARK: the real browser renderer — the one that counts (jsdom cannot run module scripts)

describe('renderPageInChild (real browser vs jsdom on a module-script SPA)', () => {
	const localBrowser = ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find(
		path => existsSync(path)
	)
	const moduleApp = `document.getElementById('root').innerHTML = '<main>Module app</main>'`
	const serveModulePage = () => {
		const page = `<!doctype html><html><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`
		const server = createServer((request, response) => {
			if (request.url === '/app.js') {
				response.writeHead(200, { 'content-type': 'text/javascript' })
				response.end(moduleApp)
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
	const withEnv = async (patch: Record<string, string | undefined>, run: () => Promise<void>) => {
		const previous = Object.fromEntries(Object.keys(patch).map(key => [key, process.env[key]]))
		for (const [key, value] of Object.entries(patch)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
		try {
			await run()
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key]
				else process.env[key] = value
			}
		}
	}

	it.skipIf(!localBrowser)('renders a <script type="module"> app in a real browser', async () => {
		const { origin, close } = await serveModulePage()
		try {
			await withEnv({ MF_RENDERER: undefined, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: localBrowser, HTTP_PROXY: undefined, HTTPS_PROXY: undefined }, async () => {
				const page = await renderPageInChild(`${origin}/`)
				expect(page.reason).toBeUndefined()
				expect(page.rootHtml).toContain('Module app')
				expect(page.errors).toEqual([])
			})
		} finally {
			close()
		}
	}, 60_000)

	it('jsdom leaves a module-script app blank — the reason the job image ships a browser', async () => {
		const { origin, close } = await serveModulePage()
		try {
			await withEnv({ MF_RENDERER: 'jsdom', MF_REQUIRE_BROWSER: undefined }, async () => {
				const page = await renderPageInChild(`${origin}/`, undefined, undefined)
				expect(page.rootHtml.trim()).toBe('')
			})
		} finally {
			close()
		}
	}, 60_000)

	it('reports a configured-but-missing browser instead of silently falling back to jsdom', async () => {
		const { origin, close } = await serveModulePage()
		try {
			await withEnv({ MF_RENDERER: undefined, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: '/nonexistent/chromium' }, async () => {
				const page = await renderPageInChild(`${origin}/`)
				expect(page.reason).toMatch(/configured browser not found/)
			})
		} finally {
			close()
		}
	}, 60_000)
})
