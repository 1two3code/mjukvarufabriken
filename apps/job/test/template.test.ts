import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The golden template every job seeds from (`TEMPLATE_DIR`, baked into the job image from
 * `templates/web`). These pin the delivery standards the template must carry so that a seeded
 * repo starts with them — `seedRepo` copies the template verbatim, so what is asserted here is
 * exactly what `/work/repo` contains before the first worker runs.
 */
const templateDir = fileURLToPath(new URL('../../../templates/web/', import.meta.url))
const appDir = join(templateDir, 'apps', 'app')

const read = (...path: string[]) => readFile(join(appDir, ...path), 'utf8')

describe('golden template — "Built by Mjukvaruhuset" footer (F5)', () => {
	it('Ships the BuiltBy component, linking to VITE_BUILT_BY_URL and hidden when it is empty', async () => {
		const component = await read('src', 'components', 'builtBy', 'BuiltBy.tsx')
		expect(component).toContain('export function BuiltBy()')
		expect(component).toContain('import.meta.env.VITE_BUILT_BY_URL')
		expect(component).toContain('if (!url) return null')
		expect(component).toContain("t('builtBy.caption')")
		expect(component).toContain('<footer')
		// The paired CSS module exists (co-location convention)
		await expect(read('src', 'components', 'builtBy', 'BuiltBy.module.css')).resolves.toContain(
			'.footer'
		)
	})

	it('Mounts the footer in App.tsx outside the router, so layout/route rewrites keep it', async () => {
		const app = await read('src', 'app', 'App.tsx')
		expect(app).toContain("import { BuiltBy } from '#/components/builtBy/BuiltBy.tsx'")
		expect(app.indexOf('<BuiltBy />')).toBeGreaterThan(app.indexOf('<RouterProvider'))
		// Not inside a layout — the layouts stay footer-free
		const layouts = ['PublicLayout.tsx', 'ProtectedLayout.tsx']
		for (const layout of layouts) {
			await expect(read('src', 'layouts', 'templates', layout)).resolves.not.toContain('BuiltBy')
		}
	})

	it('Defaults VITE_BUILT_BY_URL to https://mjukvaruhuset.se in the committed .env and types it', async () => {
		const env = await read('.env')
		expect(env).toMatch(/^VITE_BUILT_BY_URL=https:\/\/mjukvaruhuset\.se$/m)
		// .env.dev must not override it away — dev builds show the footer too
		await expect(read('.env.dev')).resolves.not.toContain('VITE_BUILT_BY_URL')
		await expect(read('src', 'env.d.ts')).resolves.toContain('readonly VITE_BUILT_BY_URL: string')
	})

	it('Keeps the protected layout loading state inside the viewport, above the footer', async () => {
		// #root is a 100dvh `auto 1fr` grid: a 100dvh loading area (the session fetch, and its
		// resting error state) pushed the footer below the fold and scrolled the page
		const css = await read('src', 'layouts', 'templates', 'ProtectedLayout.module.css')
		expect(css).not.toMatch(/height: 100dvh/)
		expect(css).toMatch(/\.loadingArea\s*\{[^}]*grid-row: 1 \/ -1;/)
	})

	it('Carries the caption in both locales', async () => {
		const en = JSON.parse(await read('public', 'locales', 'en.json')) as Record<string, string>
		const sv = JSON.parse(await read('public', 'locales', 'sv.json')) as Record<string, string>
		expect(en['builtBy.caption']).toBe('Built by Mjukvaruhuset — order your own')
		expect(sv['builtBy.caption']).toBe('Byggd av Mjukvaruhuset — beställ din egen')
	})

	it('Documents the standard and how to hide it in the template CLAUDE.md', async () => {
		const claudeMd = await readFile(join(templateDir, 'CLAUDE.md'), 'utf8')
		expect(claudeMd).toContain('components/builtBy/BuiltBy.tsx')
		expect(claudeMd).toContain('VITE_BUILT_BY_URL=')
	})
})
