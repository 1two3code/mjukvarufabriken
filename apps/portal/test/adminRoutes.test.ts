import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

/** `path: '/x'` entries of the router config */
const routerPaths = () =>
	[...read('src/app/router.tsx').matchAll(/path:\s*'([^']+)'/g)].map(match => match[1]!)

/** `to: '/x'` entries of the admin tab nav */
const adminNavLinks = () =>
	[...read('src/features/admin/AdminNav.tsx').matchAll(/to:\s*'([^']+)'/g)].map(match => match[1]!)

/**
 * Route smoke coverage (the router itself needs a browser, so this checks the config source):
 * every admin tab must resolve to a registered route, and the admin section must stay complete —
 * a page added to one side but not the other would render a dead tab or an unreachable page.
 */
describe('Portal admin routes', () => {
	it('Registers a route for every admin nav tab', () => {
		const paths = routerPaths()
		for (const link of adminNavLinks()) {
			expect(paths, link).toContain(link)
		}
	})

	it('Serves the full admin section, margin included (M12)', () => {
		const expected = [
			'/admin',
			'/admin/jobs',
			'/admin/customers',
			'/admin/resident',
			'/admin/pricing',
			'/admin/margin',
		]
		const paths = routerPaths()
		const links = adminNavLinks()
		for (const path of expected) {
			expect(paths, path).toContain(path)
			expect(links, path).toContain(path)
		}
	})

	it('Puts every admin route behind the protected layout', () => {
		const source = read('src/app/router.tsx')
		// Anchor at the ELEMENT usage — the first 'ProtectedLayout' occurrence is the import at
		// the top of the file, and slicing there would keep the whole config (public routes
		// included) in the block, making every containment check below pass vacuously.
		const anchor = 'element: <ProtectedLayout />'
		const start = source.indexOf(anchor)
		expect(start, anchor).toBeGreaterThan(-1)
		const protectedBlock = source.slice(start)
		// Self-check that the slice really excludes the public config: a public route inside the
		// block means the layout blocks were reordered and this test needs a sharper anchor.
		expect(protectedBlock, 'public /login route leaked into the protected block').not.toContain(
			"'/login'"
		)
		for (const path of routerPaths().filter(route => route.startsWith('/admin'))) {
			expect(protectedBlock, path).toContain(`'${path}'`)
		}
	})
})
