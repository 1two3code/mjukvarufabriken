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
		const protectedBlock = source.slice(source.indexOf('ProtectedLayout'))
		for (const path of routerPaths().filter(route => route.startsWith('/admin'))) {
			expect(protectedBlock, path).toContain(`'${path}'`)
		}
	})
})
