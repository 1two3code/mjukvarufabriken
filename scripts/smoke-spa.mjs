#!/usr/bin/env node
// Smoke-test built SPAs: serve each dist (SPA fallback) together with a fake `/bff` api, render
// every route in headless Chrome and require that React mounted the page (something rendered
// into #root, the layout's <main> for pages behind the session) with no console errors.
// Catches bundle-only failures (import cycles, CSP, broken asset paths, a route whose data
// shape drifted from the api) that `vite build` cannot.
//
// Routes are read from the apps' route tables (apps/portal/src/app/router.tsx and
// apps/site/src/app/routes.ts) so a new page is smoke-rendered without touching this script.
// The portal gets a fake session: the served index.html stores a token, the fake api answers
// `/bff/session` as an admin, and every other endpoint the pages call has a fixture below.
//
// Usage: node scripts/smoke-spa.mjs <app> [<app> ...]   e.g. node scripts/smoke-spa.mjs site portal
// Requires google-chrome / chromium on PATH (set CHROME_BIN to override).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

const apps = process.argv.slice(2)
if (!apps.length) {
	console.error('usage: smoke-spa.mjs <app> [...]')
	process.exit(2)
}

const chrome =
	process.env.CHROME_BIN ??
	['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(
		bin => spawnSync('which', [bin]).status === 0
	)
if (!chrome) {
	console.error('No Chrome/Chromium found on PATH (set CHROME_BIN)')
	process.exit(2)
}

// MARK: Fixtures
const now = new Date().toISOString()
const month = now.slice(0, 7)
const orderId = 'smoke-order'
const jobId = 'smoke-job'
const orgId = 'smoke-org'

const session = {
	userId: 'smoke-user',
	name: 'Smoke Admin',
	role: 'admin',
	user: { id: 'smoke-user', email: 'smoke@example.com', role: 'admin', orgId, createdAt: now },
	org: { id: orgId, name: 'Smoke AB', createdAt: now },
}

const order = {
	id: orderId,
	orgId,
	name: 'Smoke order',
	status: 'delivered',
	sizeClass: 'M',
	priceSek: 45_000,
	frozenAt: now,
	createdBy: 'smoke-user',
	createdAt: now,
	updatedAt: now,
}

const spec = {
	goal: 'A smoke-test application',
	users: ['admin'],
	features: [{ title: 'Smoke', description: 'Renders', acceptanceCriteria: ['It renders'] }],
	nonGoals: [],
	stackConstraints: [],
	sizeClass: 'M',
}

const specDraft = {
	orderId,
	orgId,
	status: 'frozen',
	spec,
	messages: [{ role: 'assistant', content: 'Hello', createdAt: now }],
	openQuestions: [],
	priceSek: 45_000,
	frozenAt: now,
}

const gate = (name, ok, summary, details) => ({
	name,
	ok,
	startedAt: now,
	durationMs: 12_000,
	tokens: 1234,
	summary,
	details,
})

const job = {
	id: jobId,
	orderId,
	orgId,
	status: 'delivered',
	spec,
	budget: { maxTokens: 15_000_000, maxDurationMinutes: 120, maxWorkers: 2 },
	tokensUsed: 4_200_000,
	gates: [
		gate('verify', true, 'Lint and tests green\n12 tests passed', { tests: 12 }),
		gate('review', true, 'No high findings', { findings: [{ id: 'a.ts:1', severity: 'low' }] }),
	],
	repositoryUrl: 'https://github.com/example/smoke',
	startedAt: now,
	finishedAt: now,
	createdAt: now,
}

const payments = [
	{
		id: 'smoke-deposit',
		orderId,
		kind: 'deposit',
		status: 'paid',
		provider: 'fake',
		amountSek: 22_500,
		vatSek: 5_625,
		totalSek: 28_125,
		sessionId: 'fake_1',
		hostedInvoiceUrl: 'https://example.com/invoice',
		paidAt: now,
		createdAt: now,
	},
	{
		id: 'smoke-balance',
		orderId,
		kind: 'balance',
		status: 'pending',
		provider: 'fake',
		amountSek: 22_500,
		vatSek: 5_625,
		totalSek: 28_125,
		sessionId: 'fake_2',
		createdAt: now,
	},
]

const deliverables = {
	jobId,
	repositoryUrl: job.repositoryUrl,
	transferPending: true,
	deployUrl: 'https://example.com/preview',
	siteUrl: null,
	deliverableKey: `deliverables/${jobId}/`,
	files: [
		{
			name: 'HANDOVER.md',
			key: `deliverables/${jobId}/HANDOVER.md`,
			size: 2048,
			url: 'https://example.com/handover',
			expiresAt: now,
		},
	],
	deliveredAt: now,
}

const jobEvents = [
	{ id: 1, jobId, type: 'started', payload: {}, createdAt: now },
	{ id: 2, jobId, type: 'done', payload: {}, createdAt: now },
]

const installation = {
	id: 'smoke-installation',
	orgId,
	billingCustomerId: 'cus_smoke',
	createdAt: now,
	updatedAt: now,
}

const residentUsage = {
	installationId: installation.id,
	orgId,
	repository: 'example/smoke',
	month,
	days: 3,
	totalTokens: 2_500_000,
	listPriceUsd: 12.5,
	billableUsd: 18.75,
	tasks: { started: 3, succeeded: 2, failed: 1, pullRequestsOpened: 2 },
	monthlyCap: { tokens: 10_000_000, usedTokens: 2_500_000 },
	report: {
		installationId: installation.id,
		month,
		usdCents: 1000,
		provider: 'fake',
		reportedAt: now,
	},
}

const items = [{ id: 'smoke-item', name: 'Smoke item', status: 'active', createdAt: now }]

/** GET fixtures per `/bff` path (query string stripped); anything else is a loud 404 */
const bff = {
	'/bff/session': session,
	'/bff/orders': [order],
	[`/bff/orders/${orderId}`]: {
		order,
		spec: { status: 'frozen', complete: true, openQuestions: 0 },
		latestJob: {
			id: jobId,
			status: job.status,
			tokensUsed: job.tokensUsed,
			budget: job.budget,
			startedAt: now,
			finishedAt: now,
			createdAt: now,
		},
		payments,
	},
	[`/bff/orders/${orderId}/spec`]: specDraft,
	[`/bff/orders/${orderId}/jobs`]: [job],
	[`/bff/jobs/${jobId}`]: job,
	[`/bff/jobs/${jobId}/events`]: jobEvents,
	[`/bff/jobs/${jobId}/deliverables`]: deliverables,
	'/bff/items': items,
	'/bff/admin/jobs': [job],
	'/bff/admin/orders': [order],
	'/bff/admin/orgs': [session.org],
	'/bff/admin/resident/installations': [installation],
	'/bff/admin/resident/usage': [residentUsage],
}

/** Route parameters substituted into the portal's route patterns */
const params = { orderId }

// MARK: Routes
const routeFile = app => resolve(`apps/${app}/src/app/${app === 'portal' ? 'router.tsx' : 'routes.ts'}`)

/**
 * Every path of the app's route table. Portal: `path: '/x/:orderId'` entries of router.tsx
 * with the params filled in; site: the `{ sv: '/x', en: '/y' }` pairs of routes.ts. The `*`
 * route becomes an unknown path so the 404 page is rendered too.
 */
const routesOf = app => {
	const source = readFileSync(routeFile(app), 'utf8')
	const matches =
		app === 'portal'
			? [...source.matchAll(/path:\s*'([^']+)'/g)].map(match => match[1])
			: [...source.matchAll(/\{\s*sv:\s*'([^']+)',\s*en:\s*'([^']+)'\s*\}/g)].flatMap(match => [
					match[1],
					match[2],
				])
	const routes = [...new Set(matches)].map(path =>
		path === '*' ? '/smoke-does-not-exist' : path.replace(/:(\w+)/g, (_, name) => params[name] ?? name)
	)
	if (routes.length < 4) throw new Error(`${app}: only ${routes.length} routes found in ${routeFile(app)}`)
	return routes
}

/** Portal pages behind the session render the ProtectedLayout's <main>; public ones do not */
const protectedRoute = (app, route) =>
	app === 'site' || !['/login', '/auth/', '/smoke-does-not-exist'].some(p => route.startsWith(p))

// MARK: Server
const mimeTypes = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.txt': 'text/plain',
	'.xml': 'application/xml',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.webmanifest': 'application/manifest+json',
}

/** The stored tokens make the portal treat the browser as signed in; `/bff/session` does the rest */
const fakeSessionScript =
	"<script>localStorage.setItem('token','smoke-token');localStorage.setItem('refreshToken','smoke-refresh')</script>"

const serveDist = (app, dist) => {
	const index = readFileSync(join(dist, 'index.html'), 'utf8')
	const html = app === 'portal' ? index.replace('<script', `${fakeSessionScript}<script`) : index

	return createServer((request, response) => {
		const { pathname } = new URL(request.url ?? '/', 'http://localhost')
		if (pathname.startsWith('/bff/')) {
			const body = request.method === 'GET' ? bff[pathname] : undefined
			if (body === undefined) {
				response.writeHead(404, { 'content-type': 'application/json' })
				response.end(JSON.stringify({ error: { message: `no fixture for ${request.method} ${pathname}` } }))
				return
			}
			response.writeHead(200, { 'content-type': 'application/json' })
			response.end(JSON.stringify(body))
			return
		}
		const file = join(dist, pathname)
		if (existsSync(file) && statSync(file).isFile()) {
			response.writeHead(200, { 'content-type': mimeTypes[extname(file)] ?? 'application/octet-stream' })
			response.end(readFileSync(file))
			return
		}
		response.writeHead(200, { 'content-type': mimeTypes['.html'] })
		response.end(html)
	})
}

/** Listens on a free port (several smoke runs may share the machine) and resolves with it */
const listen = server =>
	new Promise((resolvePromise, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => resolvePromise(server.address().port))
	})

// MARK: Rendering
// Own profile per run: a concurrent Chrome on the default profile would take over the launch
const userDataDir = mkdtempSync(join(tmpdir(), 'smoke-spa-'))
process.on('exit', () => rmSync(userDataDir, { recursive: true, force: true }))

const renderDom = url => {
	const args = [
		'--headless=new',
		'--no-sandbox',
		'--disable-gpu',
		`--user-data-dir=${userDataDir}`,
		'--enable-logging=stderr',
		'--v=0',
		'--virtual-time-budget=8000',
		'--dump-dom',
		url,
	]
	// Async: the page is served by this very process, so a blocking spawn would deadlock
	return new Promise(resolvePromise => {
		const child = spawn(chrome, args)
		let dom = ''
		let log = ''
		child.stdout.on('data', chunk => (dom += chunk))
		child.stderr.on('data', chunk => (log += chunk))
		const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
		child.on('close', () => {
			clearTimeout(timer)
			resolvePromise({ dom, log })
		})
	})
}

const consoleErrors = log =>
	log
		.split('\n')
		.filter(line =>
			/ERROR:CONSOLE|Uncaught|TypeError|ReferenceError|Refused to|Failed to load/i.test(line)
		)

const smokeRoute = async (app, base, route) => {
	const { dom, log } = await renderDom(`${base}${route}`)
	const root = dom.match(/<div id="root">([\s\S]*?)<\/div>\s*<\/body>/)?.[1] ?? ''
	const errors = consoleErrors(log)
	if (!root.trim()) throw new Error(`${app} ${route}: nothing rendered into #root`)
	if (errors.length) throw new Error(`${app} ${route}: console errors:\n${errors.join('\n')}`)
	if (protectedRoute(app, route) && !/<main[\s>]/.test(root)) {
		throw new Error(`${app} ${route}: no <main> rendered (session not accepted or page crashed)`)
	}
	return root.length
}

const smoke = async app => {
	const dist = resolve(`apps/${app}/dist/live`)
	if (!existsSync(dist)) throw new Error(`${app}: ${dist} missing — run npm run build first`)

	const server = serveDist(app, dist)
	const port = await listen(server)
	const failures = []
	try {
		const base = `http://127.0.0.1:${port}`
		for (const route of routesOf(app)) {
			try {
				const length = await smokeRoute(app, base, route)
				console.log(`  ✓ ${app} ${route}: ${length} chars`)
			} catch (error) {
				failures.push(error.message)
				console.error(`  ✗ ${error.message}`)
			}
		}
	} finally {
		server.close()
	}
	if (failures.length) throw new Error(`${app}: ${failures.length} route(s) failed`)
	console.log(`✓ ${app}: every route rendered without console errors`)
}

let failed = false
for (const app of apps) {
	try {
		await smoke(app)
	} catch (error) {
		failed = true
		console.error(`✗ ${error.message}`)
	}
}
process.exit(failed ? 1 : 0)
