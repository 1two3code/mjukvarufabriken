import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

/**
 * Every autoloaded route must live under `/bff`.
 *
 * The SPA talks to the backend through a single base URL (`VITE_API_URL`, `/bff` in production),
 * so a route registered anywhere else is unreachable from the app no matter how correct it is:
 * the browser asks for `/bff/photos`, the server serves `/photos`, and every request 404s. The
 * failure is silent in unit tests — the route's own test calls it directly and passes — and only
 * shows when something exercises the app the way a browser does.
 *
 * This is the second time that exact mismatch has cost a build. It sank the original guestbook
 * delivery, and dogfood run 4 (2026-09-01) failed its review gate on it again: photo endpoints
 * registered at `/photos*` while the gallery fetched `/bff/photos`, so the app would have shipped
 * with no images at all. A prompt convention did not prevent it twice, so it graduates to a check
 * the worker's own gate runs.
 */
const routesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes')

/** Prefixes a route may use. `/health` and `/internal` are registered outside `src/routes`. */
const allowedPrefixes = ['/bff']

const walk = async (dir: string): Promise<string[]> => {
	const entries = await readdir(dir, { withFileTypes: true })
	const files = await Promise.all(
		entries.map(entry => {
			const path = join(dir, entry.name)
			if (entry.isDirectory()) return walk(path)
			return Promise.resolve(entry.name.endsWith('.ts') ? [path] : [])
		})
	)
	return files.flat()
}

/** `app.get('/bff/items/:id', …)` / `app.post("/photos", …)` → the quoted path */
const registeredPaths = (source: string) =>
	[...source.matchAll(/\bapp\s*\.\s*(?:get|post|put|patch|delete|head|options|all)\s*\(\s*['"`]([^'"`]+)/g)].map(
		match => match[1]!
	)

describe('route prefixes', () => {
	it('registers every route under /bff so the SPA can actually reach it', async () => {
		const files = await walk(routesDir)
		expect(files.length).toBeGreaterThan(0)

		const offenders: string[] = []
		for (const file of files) {
			for (const path of registeredPaths(await readFile(file, 'utf8'))) {
				if (!allowedPrefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) {
					offenders.push(`${relative(routesDir, file)} registers ${path}`)
				}
			}
		}

		expect(
			offenders,
			`routes outside ${allowedPrefixes.join(', ')} are unreachable from the SPA:\n${offenders.join('\n')}`
		).toEqual([])
	})
})
