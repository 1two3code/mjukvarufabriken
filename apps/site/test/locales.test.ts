import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { languages } from '#/app/routes.ts'

const root = join(import.meta.dirname, '..')
const loadLocale = (language: string): Record<string, string> =>
	JSON.parse(readFileSync(join(root, 'public/locales', `${language}.json`), 'utf8'))

/** Every source file under src, recursively */
const sourceFiles = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) return sourceFiles(path)
		return /\.(ts|tsx)$/.test(entry.name) ? [path] : []
	})

/**
 * Literal translation keys used in the source: `t('a.b')`, `usePageMeta('a', 'b')` and
 * `message: 'api.error.x'`-style toast keys. Template keys (`t(\`home.built.${point}\`)`)
 * are covered by the prefix check below.
 */
const usedKeys = () => {
	const literal = new Set<string>()
	const prefixes = new Set<string>()
	for (const file of sourceFiles(join(root, 'src'))) {
		const source = readFileSync(file, 'utf8')
		for (const match of source.matchAll(/\bt\(\s*'([a-zA-Z0-9.]+)'/g)) literal.add(match[1]!)
		for (const match of source.matchAll(/usePageMeta\('([^']+)',\s*'([^']+)'\)/g)) {
			literal.add(match[1]!).add(match[2]!)
		}
		for (const match of source.matchAll(/\bt\(\s*`([a-zA-Z0-9.]+)\.\$\{/g)) prefixes.add(match[1]!)
	}
	return { literal, prefixes }
}

describe('Locales', () => {
	const locales = Object.fromEntries(languages.map(language => [language, loadLocale(language)]))
	const [reference, ...others] = languages

	it('Has the same keys in every language', () => {
		const referenceKeys = Object.keys(locales[reference!]!).sort()
		for (const language of others) {
			expect(Object.keys(locales[language]!).sort(), language).toEqual(referenceKeys)
		}
	})

	it('Defines every key used in the source (no raw keys rendered)', () => {
		const { literal, prefixes } = usedKeys()
		const keys = Object.keys(locales[reference!]!)
		expect(literal.size).toBeGreaterThan(50)

		const missing = [...literal].filter(key => !(key in locales[reference!]!))
		expect(missing).toEqual([])

		const missingPrefixes = [...prefixes].filter(
			prefix => !keys.some(key => key.startsWith(`${prefix}.`))
		)
		expect(missingPrefixes).toEqual([])
	})

	it('Has no empty values', () => {
		for (const [language, values] of Object.entries(locales)) {
			const empty = Object.entries(values).filter(([, value]) => !value.trim())
			expect(empty, language).toEqual([])
		}
	})
})
