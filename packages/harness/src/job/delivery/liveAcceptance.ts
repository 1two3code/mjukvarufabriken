import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { sandboxEnv } from '#job/exec.ts'

import { judgeAnonymousProbe, readPublicUrls } from './authReconcile.ts'
import { extractFrontendApiSurface, findFrontendAppDir } from './wiredSmoke.ts'

/**
 * !!! The lesson after wiredSmoke: everything before this point verifies PROXIES of the delivery
 * (lint, tests, a local boot, local route probes). Nobody ever visited the URL the customer
 * gets. This is that visit — the post-deploy end-to-end acceptance check (Gate C, strategy
 * 2026-08-31): once ECS Express hands out the live URL, fetch the SPA like a browser, render it
 * headless and fail on console errors / a blank root, then replay the SPA's API calls against
 * the LIVE backend — token-aware, and reconciled against the app's own `publicUrls` allowlist.
 *
 * Fail-closed rules (each one is a class of shipped-broken app from the 2026-08-30 audit):
 *   - the probe surface is empty or undiscoverable → FAIL (a gate that verified nothing must
 *     not report success — the root pattern behind the audit's B findings)
 *   - 401/403 anywhere a visitor lands → FAIL (guestbook incident, second half; A1)
 *   - 5xx → FAIL (dead database / placeholder env; C1/D1 — a 500 is not "the route exists")
 *   - blank #root or console errors in the rendered page → FAIL (D2)
 * A failure does not tear the service down — delivery withholds the URL from the deliverable
 * and pages the admins with the probe report instead (deliver.ts).
 */

// MARK: Result types

export type LiveProbe = {
	method: string
	path: string
	/** Status of the anonymous probe (0 = no response) */
	status: number
	/** Status of the minted-token probe, when one ran (only on anonymous 401/403) */
	tokenStatus?: number
	ok: boolean
	reason?: string
}

export type LiveAcceptanceResult = {
	ok: boolean
	/** Why the check failed — every failing probe/render finding, newline-joined */
	reason?: string
	probes: LiveProbe[]
	/** Characters rendered into #root by the headless render (0 = blank) */
	renderedChars?: number
}

// MARK: Injectable ports

/** Minimal fetch surface the check needs (injectable; default: global fetch) */
export type LiveFetch = (
	url: string,
	init: { method: string; headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ status: number; text: () => Promise<string> }>

export type RenderedPage = { rootHtml: string; errors: string[]; reason?: string }
export type PageRenderer = (url: string, signal?: AbortSignal) => Promise<RenderedPage>

/**
 * Mints a short-lived access token for the delivered preview's auth contract (the api's
 * `/internal/jobs/:jobId/preview-token`, wired through the job's reporter credentials).
 * Undefined = minting unavailable; 401 probes then fail without the token diagnosis.
 */
export type PreviewTokenMinter = () => Promise<string | undefined>

export type LiveCheckInput = { url: string; repoDir: string; signal?: AbortSignal }
export type LiveCheck = { check: (input: LiveCheckInput) => Promise<LiveAcceptanceResult> }

// MARK: Default renderer (jsdom in a sandboxed child process)

const renderScript = fileURLToPath(new URL('./renderPage.script.ts', import.meta.url))

/**
 * Runs renderPage.script.ts (jsdom) as a child with the harness sandboxEnv — the delivered
 * bundle is untrusted code, so it never executes inside the job process itself.
 */
export const renderPageInChild = (url: string, signal?: AbortSignal): Promise<RenderedPage> =>
	new Promise(resolve => {
		const child = spawn(process.execPath, [renderScript, url], {
			env: sandboxEnv(),
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let stdout = ''
		let stderr = ''
		let settled = false
		const settle = (page: RenderedPage) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener('abort', onAbort)
			resolve(page)
		}
		const onAbort = () => {
			child.kill('SIGKILL')
			settle({ rootHtml: '', errors: [], reason: 'aborted' })
		}
		const timer = setTimeout(() => {
			child.kill('SIGKILL')
			settle({ rootHtml: '', errors: [], reason: 'render process timed out' })
		}, 60_000)
		signal?.addEventListener('abort', onAbort, { once: true })
		child.stdout.on('data', chunk => (stdout += String(chunk)))
		child.stderr.on('data', chunk => (stderr += String(chunk)))
		child.on('error', error => settle({ rootHtml: '', errors: [], reason: `spawn failed: ${error.message}` }))
		child.on('close', code => {
			try {
				settle(JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as RenderedPage)
			} catch {
				settle({
					rootHtml: '',
					errors: [],
					reason: `render process exited (${code}) without a result${stderr ? `: ${stderr.slice(0, 400)}` : ''}`,
				})
			}
		})
	})

// MARK: Pure helpers

/** The bundle/stylesheet paths the served index.html references (`/assets/index-*.js`, …) */
export const extractAssetPaths = (html: string): string[] => [
	...new Set(
		[...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map(match => match[1]!)
	),
]

const successish = (status: number) => (status >= 200 && status < 400) || status === 400

// MARK: The check

export type LiveAcceptanceOptions = {
	fetchFn?: LiveFetch
	render?: PageRenderer
	mintToken?: PreviewTokenMinter
}

export const createLiveAcceptanceCheck = ({
	fetchFn = fetch,
	render = renderPageInChild,
	mintToken,
}: LiveAcceptanceOptions = {}): LiveCheck => ({
	check: async ({ url, repoDir, signal }) => {
		const origin = url.replace(/\/+$/, '')
		const failures: string[] = []
		const probes: LiveProbe[] = []
		const get = async (target: string, method = 'GET', token?: string) => {
			try {
				const response = await fetchFn(target, {
					method,
					...(token && { headers: { authorization: `Bearer ${token}` } }),
					signal,
				})
				return response
			} catch {
				return undefined
			}
		}

		// 1. The landing page: the exact request the customer's browser makes first
		const landing = await get(`${origin}/`)
		const landingHtml = landing && landing.status === 200 ? await landing.text().catch(() => '') : ''
		if (!landing || landing.status !== 200) {
			failures.push(`GET / → ${landing?.status ?? 'no response'} (expected the SPA's HTML)`)
		} else if (!/id="root"/.test(landingHtml)) {
			failures.push('GET / returned HTML without a #root element — the SPA is not being served')
		}

		// 2. One referenced bundle asset: catches a misconfigured Vite `base` (assets 404 → blank page)
		const assets = extractAssetPaths(landingHtml)
		const script = assets.find(asset => asset.endsWith('.js')) ?? assets[0]
		if (landingHtml && !script) {
			failures.push('the served HTML references no bundle assets — nothing would execute in a browser')
		} else if (script) {
			const asset = await get(`${origin}${script}`)
			if (!asset || asset.status !== 200) {
				failures.push(`asset ${script} → ${asset?.status ?? 'no response'} (bundle unreachable — blank page)`)
			}
		}

		// 3. Headless render — the browser's verdict: something in #root, no fatal console errors
		let renderedChars: number | undefined
		if (landingHtml) {
			const page = await render(`${origin}/`, signal)
			renderedChars = page.rootHtml.trim().length
			if (page.reason) failures.push(`headless render: ${page.reason}`)
			else if (page.errors.length) {
				failures.push(`console errors in the rendered page: ${page.errors.slice(0, 5).join(' | ')}`)
			} else if (!renderedChars) {
				failures.push('blank page: the headless render put nothing into #root')
			}
		}

		// 4. The API surface, fail-closed: a probe set we cannot discover is a failure, not a pass —
		// a gate that verified nothing must never report success (audit class B).
		const appDir = await findFrontendAppDir(repoDir)
		const surface = appDir ? await extractFrontendApiSurface(repoDir) : undefined
		if (!appDir) {
			failures.push('no frontend app found in the delivered repo — probe surface undiscoverable (fail closed)')
		} else if (!surface) {
			failures.push(
				'the frontend declares no VITE_API_URL — its API base is undiscoverable, so the live API surface cannot be verified (fail closed)'
			)
		} else if (surface.calls.length === 0) {
			failures.push(
				'no static API calls could be extracted from the frontend — the probe surface is empty, so the live API surface cannot be verified (fail closed)'
			)
		} else {
			// 5. Probe every SPA call like the anonymous visitor; on 401/403 mint a preview token and
			// probe again so an auth-gated surface is actually exercised, not just observed as locked.
			const publicUrls = await readPublicUrls(repoDir)
			let token: string | undefined
			for (const call of surface.calls) {
				const target = `${origin}${surface.base}${call.path}`
				const response = await get(target, call.method)
				const status = response?.status ?? 0
				// Judge the FULL route path — publicUrls entries are full routes (`/bff/…`)
				const verdict = judgeAnonymousProbe(`${surface.base}${call.path}`, status, publicUrls)
				const probe: LiveProbe = { method: call.method, path: call.path, status, ok: verdict.ok }
				if (!verdict.ok && (status === 401 || status === 403) && mintToken) {
					token ??= await mintToken().catch(() => undefined)
					if (token) {
						const withToken = await get(target, call.method, token)
						probe.tokenStatus = withToken?.status ?? 0
						probe.reason =
							`${verdict.reason} — with a freshly-minted preview token the route ` +
							(successish(probe.tokenStatus)
								? `answers ${probe.tokenStatus}: it works but only for authenticated users`
								: `still fails (${probe.tokenStatus}): broken even with valid auth`)
					}
				}
				probe.reason ??= verdict.reason
				probes.push(probe)
				if (!probe.ok) failures.push(`${call.method} ${surface.base}${call.path}: ${probe.reason}`)
			}
		}

		return failures.length
			? { ok: false, reason: failures.join('\n'), probes, renderedChars }
			: { ok: true, probes, renderedChars }
	},
})

// MARK: Fakes

export type FakeLiveCheck = LiveCheck & { calls: LiveCheckInput[] }

export const createFakeLiveCheck = (
	result: LiveAcceptanceResult = { ok: true, probes: [] }
): FakeLiveCheck => {
	const fake: FakeLiveCheck = {
		calls: [],
		check: async input => {
			fake.calls.push(input)
			return result
		},
	}
	return fake
}

export const createDryRunLiveCheck = (log: (line: string) => void): LiveCheck => ({
	check: async ({ url }) => {
		log(`[dry-run] live acceptance: would probe ${url} (SPA render + token-aware API probes)`)
		return { ok: true, probes: [] }
	},
})
