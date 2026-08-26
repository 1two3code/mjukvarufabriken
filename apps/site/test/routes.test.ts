import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { languageFromPath, languages, pagePaths, pages } from '#/app/routes.ts'

describe('Site routes', () => {
	it('Gives every page a distinct path per language, Swedish at the root', () => {
		const paths = pages.flatMap(page => languages.map(language => pagePaths[page][language]))
		expect(new Set(paths).size).toBe(paths.length)
		expect(pagePaths.home.sv).toBe('/')
		expect(paths.every(path => path.startsWith('/'))).toBe(true)
	})

	it.each([
		['/', 'sv'],
		['/priser/', 'sv'],
		['/en', 'en'],
		['/en/', 'en'],
		['/how-it-works', 'en'],
		['/en/anything-broken', 'en'],
		['/how-it-work', 'sv'],
		['/enough', 'sv'],
	])('languageFromPath(%s) → %s', (path, language) => {
		expect(languageFromPath(path)).toBe(language)
	})

	it('Lists every page path per language in sitemap.xml', () => {
		const sitemap = readFileSync(join(import.meta.dirname, '../public/sitemap.xml'), 'utf8')
		for (const page of pages) {
			for (const language of languages) {
				expect(sitemap).toContain(`https://mjukvaruhuset.se${pagePaths[page][language]}`)
			}
		}
	})
})
