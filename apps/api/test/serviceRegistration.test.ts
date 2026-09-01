import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Every service must actually be registered in `server.ts`.
 *
 * Routes are autoloaded; services are not — they are imported and `.register()`ed by hand. A
 * service that is written, tested and given a route but never registered therefore fails only at
 * RUNTIME, as `Cannot read properties of undefined (reading '<method>')`, with a route that 500s
 * instead of 404s. Nothing in the suite notices, because `createTestApp()` auto-mocks services
 * from `__mocks__/` — the real registration list is never exercised.
 *
 * That is exactly how `previewStorageService` reached a live delivery unregistered (dogfood run 2,
 * 2026-09-01): 1 396 tests green, the storage endpoint 500ing in production, and the delivery
 * correctly failing closed on a capability that existed in the codebase but not in the server.
 *
 * This is a static drift check rather than a behavioural one on purpose — it costs nothing and
 * cannot be forgotten, which is the property that matters for a wiring list a human edits by hand.
 */
const here = dirname(fileURLToPath(import.meta.url))
const servicesDir = join(here, '..', 'src', 'services')
const serverPath = join(here, '..', 'src', 'server.ts')

describe('service registration', () => {
	it('registers every service in server.ts', async () => {
		const [entries, server] = await Promise.all([
			readdir(servicesDir, { withFileTypes: true }),
			readFile(serverPath, 'utf8'),
		])
		const services = entries
			.filter(entry => entry.isFile() && entry.name.endsWith('Service.ts'))
			.map(entry => entry.name.replace(/\.ts$/, ''))

		expect(services.length).toBeGreaterThan(0)
		const missing = services.filter(
			name => !server.includes(`#/services/${name}.ts`) || !server.includes(`.register(${name})`)
		)
		expect(missing, `services present but not registered in server.ts: ${missing.join(', ')}`).toEqual(
			[]
		)
	})
})
