/**
 * Headless SPA render for the post-deploy acceptance check (liveAcceptance.ts) — the
 * `scripts/smoke-spa.mjs` idea (render the built bundle, require something in #root and no
 * console errors) without Chrome, which the job container does not ship: jsdom executes the
 * page's scripts instead. Run as a CHILD process (`node renderPage.script.ts <url> [timeoutMs]`)
 * with the harness sandboxEnv, never in-process — the delivered bundle is untrusted code.
 *
 * Prints a single JSON line to stdout: `{ rootHtml, errors, reason? }`. A non-JSON stdout or a
 * non-zero exit is treated as a failed render by the parent.
 */
import { JSDOM, VirtualConsole } from 'jsdom'

const url = process.argv[2]
const timeoutMs = Number(process.argv[3] ?? 20_000)

const finish = (result: { rootHtml: string; errors: string[]; reason?: string }) => {
	console.log(JSON.stringify(result))
	process.exit(0)
}

if (!url) finish({ rootHtml: '', errors: [], reason: 'no url given' })
const pageUrl = url as string

const errors: string[] = []
/** Mirrors smoke-spa.mjs' consoleErrors filter: only lines that indicate the bundle broke */
const isFatalConsoleLine = (line: string) =>
	/Uncaught|TypeError|ReferenceError|SyntaxError|is not defined|Failed to load|Refused to/i.test(line)

const virtualConsole = new VirtualConsole()
virtualConsole.on('jsdomError', error =>
	errors.push(String((error as Error)?.message ?? error).split('\n')[0]!)
)
virtualConsole.on('error', (...args: unknown[]) => {
	const line = args.map(String).join(' ').split('\n')[0]!
	if (isFatalConsoleLine(line)) errors.push(line)
})

/**
 * jsdom implements neither fetch nor matchMedia; without them every real SPA throws on boot and
 * the render would fail for the wrong reason. fetch is Node's own, resolved against the page URL
 * (the SPA calls relative `/bff/...` paths); the delivered app's API lives on the same origin,
 * so the probe exercises the LIVE backend exactly like a browser would.
 */
const polyfill = (window: JSDOM['window']) => {
	const win = window as unknown as Record<string, unknown>
	win.fetch = (input: unknown, init?: RequestInit) =>
		fetch(new URL(String(input), pageUrl), init)
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

try {
	const dom = await JSDOM.fromURL(pageUrl, {
		resources: 'usable',
		runScripts: 'dangerously',
		pretendToBeVisual: true,
		virtualConsole,
		beforeParse: polyfill,
	})
	const rootOf = () => dom.window.document.getElementById('root')?.innerHTML ?? ''
	const deadline = Date.now() + timeoutMs
	// Poll until React mounted something into #root (plus one settle tick so an immediate crash
	// after mount still surfaces), or until the budget runs out — then report what there is.
	const poll = () => {
		if (rootOf().trim() || Date.now() >= deadline) {
			setTimeout(() => finish({ rootHtml: rootOf(), errors }), 250)
			return
		}
		setTimeout(poll, 250)
	}
	poll()
	// Never hang the parent: hard stop well past the deadline even if timers were swallowed
	setTimeout(() => finish({ rootHtml: rootOf(), errors, reason: 'render timed out' }), timeoutMs + 5_000).unref()
} catch (error) {
	finish({ rootHtml: '', errors, reason: `jsdom failed: ${(error as Error).message}` })
}
