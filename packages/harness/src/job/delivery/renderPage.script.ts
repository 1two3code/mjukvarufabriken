/**
 * Renders a live page the way the customer's browser will and reports what landed in `#root`
 * plus any fatal console/page errors. Run as a CHILD process (`node renderPage.script.ts <url>
 * [timeoutMs]`) through the same setpriv worker sandbox as every other untrusted execution; the
 * result is one JSON line on stdout.
 *
 * Two renderers:
 * - **A real headless Chromium** (playwright-core + the image's chromium, found via
 *   `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` or the usual paths). This is the one that counts: every
 *   Vite build ships `<script type="module">`, which jsdom silently never executes — dogfood run 8
 *   (2026-09-02) had a fully working app judged "blank page" for exactly that reason.
 * - **jsdom**, only when no browser exists (local `job:dev`, tests) and `MF_REQUIRE_BROWSER` is
 *   not set. It cannot run module scripts; the result says which renderer produced it.
 */
import { existsSync } from 'node:fs'

import { JSDOM, VirtualConsole } from 'jsdom'

type Rendered = { rootHtml: string; errors: string[]; reason?: string; renderer?: 'browser' | 'jsdom' }

const url = process.argv[2]
const timeoutMs = Number(process.argv[3] ?? 20_000)

const finish = (result: Rendered) => {
	console.log(JSON.stringify(result))
	process.exit(0)
}

if (!url) finish({ rootHtml: '', errors: [], reason: 'no url given' })
const pageUrl = url as string

const isFatalConsoleLine = (line: string) =>
	/Uncaught|TypeError|ReferenceError|SyntaxError|is not defined|Failed to load|Refused to/i.test(line)

// MARK: Browser

const candidateBrowsers = [
	process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
	'/usr/bin/chromium-browser',
	'/usr/bin/chromium',
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
].filter((path): path is string => Boolean(path))

/** The configured browser first; a configured-but-missing one is an error, never a silent fallback */
const findBrowser = (): { path?: string; reason?: string } => {
	// Tests pin the fallback explicitly; production never sets this
	if (process.env.MF_RENDERER === 'jsdom') return {}
	const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
	if (configured && !existsSync(configured)) {
		return { reason: `configured browser not found: ${configured}` }
	}
	const path = candidateBrowsers.find(candidate => existsSync(candidate))
	if (path) return { path }
	if (process.env.MF_REQUIRE_BROWSER) return { reason: 'no browser available for the live render' }
	return {}
}

const proxyOf = () => {
	const server = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
	return server ? { server, bypass: process.env.NO_PROXY } : undefined
}

const renderInBrowser = async (executablePath: string): Promise<Rendered> => {
	const { chromium } = await import('playwright-core')
	const errors: string[] = []
	const browser = await chromium.launch({
		executablePath,
		headless: true,
		proxy: proxyOf(),
		args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
	})
	try {
		const page = await browser.newPage({ ignoreHTTPSErrors: false })
		// `String(error)` keeps the class name (`TypeError: …`), the shape jsdom reported and the
		// live check greps for
		page.on('pageerror', error => errors.push(String(error).split('\n')[0]!))
		page.on('console', message => {
			if (message.type() !== 'error') return
			const line = message.text().split('\n')[0]!
			if (isFatalConsoleLine(line)) errors.push(line)
		})
		page.on('requestfailed', request => {
			const failure = request.failure()?.errorText ?? 'failed'
			errors.push(`Failed to load ${request.url()}: ${failure}`)
		})
		await page.goto(pageUrl, { waitUntil: 'load', timeout: timeoutMs })
		const rootOf = () => page.locator('#root').first().innerHTML({ timeout: 1_000 }).catch(() => '')
		const deadline = Date.now() + timeoutMs
		let rootHtml = await rootOf()
		// Keep polling while the root is empty — unless the page already crashed, in which case a
		// short grace is enough: nothing is coming
		const crashedAt = () => (errors.length ? Date.now() : undefined)
		let crashSeen = crashedAt()
		while (!rootHtml.trim() && Date.now() < deadline) {
			if (crashSeen && Date.now() - crashSeen > 1_500) break
			await page.waitForTimeout(250)
			rootHtml = await rootOf()
			crashSeen ??= crashedAt()
		}
		// One more beat so a just-mounted app finishes its first paint and errors
		await page.waitForTimeout(250)
		rootHtml = await rootOf()
		return { rootHtml, errors, renderer: 'browser' }
	} finally {
		await browser.close().catch(() => {})
	}
}

// MARK: jsdom (fallback without a browser)

const renderInJsdom = async (): Promise<Rendered> => {
	const errors: string[] = []
	const virtualConsole = new VirtualConsole()
	virtualConsole.on('jsdomError', error =>
		errors.push(String((error as Error)?.message ?? error).split('\n')[0]!)
	)
	virtualConsole.on('error', (...args: unknown[]) => {
		const line = args.map(String).join(' ').split('\n')[0]!
		if (isFatalConsoleLine(line)) errors.push(line)
	})
	const polyfill = (window: JSDOM['window']) => {
		const win = window as unknown as Record<string, unknown>
		win.fetch = (input: unknown, init?: RequestInit) => fetch(new URL(String(input), pageUrl), init)
		win.matchMedia = (query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		})
		win.scrollTo = () => {}
	}
	const dom = await JSDOM.fromURL(pageUrl, {
		resources: 'usable',
		runScripts: 'dangerously',
		pretendToBeVisual: true,
		virtualConsole,
		beforeParse: polyfill,
	})
	const rootOf = () => dom.window.document.getElementById('root')?.innerHTML ?? ''
	const deadline = Date.now() + timeoutMs
	return new Promise<Rendered>(resolve => {
		const poll = () => {
			if (rootOf().trim() || Date.now() >= deadline) {
				setTimeout(() => resolve({ rootHtml: rootOf(), errors, renderer: 'jsdom' }), 250)
				return
			}
			setTimeout(poll, 250)
		}
		poll()
	})
}

// MARK: Main

setTimeout(
	() => finish({ rootHtml: '', errors: [], reason: 'render timed out' }),
	timeoutMs * 2 + 10_000
).unref()

try {
	const browser = findBrowser()
	if (browser.reason) finish({ rootHtml: '', errors: [], reason: browser.reason })
	finish(browser.path ? await renderInBrowser(browser.path) : await renderInJsdom())
} catch (error) {
	finish({ rootHtml: '', errors: [], reason: `render failed: ${(error as Error).message}` })
}
