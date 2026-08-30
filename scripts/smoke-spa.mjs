#!/usr/bin/env node
// Smoke-test built SPAs: serve each dist with `vite preview`, render it in headless Chrome and
// require that React actually mounted (something rendered into #root) with no uncaught errors.
// Catches bundle-only failures (import cycles, CSP, broken asset paths) that `vite build` cannot.
//
// Usage: node scripts/smoke-spa.mjs <app> [<app> ...]   e.g. node scripts/smoke-spa.mjs site portal
// Requires google-chrome / chromium on PATH (set CHROME_BIN to override).

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

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

const sleep = ms => new Promise(r => setTimeout(r, ms))

const waitForServer = async (url, attempts = 40) => {
	for (let i = 0; i < attempts; i++) {
		try {
			const res = await fetch(url)
			if (res.ok) return
		} catch {
			// not up yet
		}
		await sleep(250)
	}
	throw new Error(`preview server at ${url} did not start`)
}

const renderDom = url => {
	const args = [
		'--headless=new',
		'--no-sandbox',
		'--disable-gpu',
		'--enable-logging=stderr',
		'--v=0',
		'--virtual-time-budget=8000',
		'--dump-dom',
		url,
	]
	const result = spawnSync(chrome, args, { encoding: 'utf8', timeout: 60_000 })
	return { dom: result.stdout ?? '', log: result.stderr ?? '' }
}

const smoke = async (app, port) => {
	const dist = resolve(`apps/${app}/dist/live`)
	if (!existsSync(dist)) throw new Error(`${app}: ${dist} missing — run npm run build first`)

	const server = spawn(
		'npx',
		['vite', 'preview', '--config', `apps/${app}/vite.config.ts`, '--outDir', dist, '--port', String(port), '--strictPort'],
		{ stdio: 'ignore' }
	)
	try {
		const url = `http://localhost:${port}/`
		await waitForServer(url)
		const { dom, log } = renderDom(url)

		const root = dom.match(/<div id="root">([\s\S]*?)<\/div>\s*<\/body>/)?.[1] ?? ''
		const errors = log
			.split('\n')
			.filter(line => /Uncaught|TypeError|ReferenceError|Refused to|Failed to load/i.test(line))

		if (!root.trim()) throw new Error(`${app}: nothing rendered into #root`)
		if (errors.length) throw new Error(`${app}: console errors:\n${errors.join('\n')}`)
		console.log(`✓ ${app}: rendered ${root.length} chars into #root, no console errors`)
	} finally {
		server.kill()
	}
}

let failed = false
for (const [index, app] of apps.entries()) {
	try {
		await smoke(app, 4200 + index)
	} catch (error) {
		failed = true
		console.error(`✗ ${error.message}`)
	}
}
process.exit(failed ? 1 : 0)
