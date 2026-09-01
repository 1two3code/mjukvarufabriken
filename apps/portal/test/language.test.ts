import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
	defaultLanguage,
	isLanguage,
	languageDetection,
	languages,
	languageStorageKey,
	nextLanguage,
	normalizeLanguage,
} from '#/app/language.ts'

import type { ReactElement, ReactNode } from 'react'

// The toggle only needs `t` and the `i18n` handle; echo the key so assertions can see it.
const i18nMock = vi.hoisted(() => ({ language: 'en', changeLanguage: vi.fn() }))
vi.mock('react-i18next', () => ({
	useTranslation: () => ({ t: (key: string) => key, i18n: i18nMock }),
}))

const { LanguageToggle } = await import('#/features/language/LanguageToggle.tsx')
const { Button } = await import('#/components/Button.tsx')

const root = join(import.meta.dirname, '..')
const readSource = (path: string) => readFileSync(join(root, path), 'utf8')
const loadLocale = (language: string): Record<string, string> =>
	JSON.parse(readSource(join('public/locales', `${language}.json`)))

describe('Portal language selection', () => {
	describe('normalizeLanguage / nextLanguage', () => {
		it('Ships both languages the locale files cover', () => {
			expect([...languages]).toEqual(['en', 'sv'])
			expect(defaultLanguage).toBe('en')
			expect(isLanguage('sv')).toBe(true)
			expect(isLanguage('de')).toBe(false)
		})

		it('Maps a regional tag onto the bundle we ship', () => {
			// The browser sends `sv-SE`; without this the portal would ask for a `sv-SE.json`
			// that does not exist and silently fall back to English.
			expect(normalizeLanguage('sv-SE')).toBe('sv')
			expect(normalizeLanguage('EN-GB')).toBe('en')
		})

		it('Falls back for an unknown, empty or missing language', () => {
			expect(normalizeLanguage('de')).toBe('en')
			expect(normalizeLanguage('')).toBe('en')
			expect(normalizeLanguage(undefined)).toBe('en')
			expect(normalizeLanguage(null)).toBe('en')
		})

		it('Cycles through every shipped language', () => {
			expect(nextLanguage('en')).toBe('sv')
			expect(nextLanguage('sv')).toBe('en')
			expect(nextLanguage('sv-SE')).toBe('en')
			expect(nextLanguage(undefined)).toBe('sv')
		})
	})

	describe('detection options', () => {
		it('Prefers the stored choice over the browser, and caches the choice', () => {
			expect(languageDetection.order).toEqual(['localStorage', 'navigator'])
			expect(languageDetection.caches).toEqual(['localStorage'])
			expect(languageDetection.lookupLocalStorage).toBe(languageStorageKey)
		})
	})

	// i18next resolves to `fallbackLng` on every load unless something picks a language: with no
	// detector and no `lng`, `sv` is unreachable however complete sv.json is.
	describe('i18n bootstrap', () => {
		const source = readSource('src/app/i18n.ts')

		it('Installs the browser language detector', () => {
			expect(source).toMatch(/\.use\(LanguageDetector\)/)
			expect(source).toContain('detection: languageDetection')
		})

		it('Loads by language only, so `sv-SE` uses the `sv` bundle', () => {
			expect(source).toContain("load: 'languageOnly'")
		})

		it('Keeps the document language in sync (index.html can only ship a static lang)', () => {
			expect(source).toMatch(/languageChanged/)
			expect(source).toMatch(/document\.documentElement\.lang/)
		})

		it('Declares the detector as a dependency', () => {
			const pkg = JSON.parse(readSource('package.json'))
			expect(pkg.dependencies['i18next-browser-languagedetector']).toBeTruthy()
		})
	})

	describe('the header toggle', () => {
		it('Is rendered in the header', () => {
			const header = readSource('src/layouts/header/Header.tsx')
			expect(header).toContain('<LanguageToggle />')
		})

		type El = { type: unknown; props: { children?: ReactNode; onClick?: () => void } }
		const isElement = (node: unknown): node is El =>
			typeof node === 'object' && node !== null && 'type' in node && 'props' in node
		const findByType = (node: ReactNode, target: unknown): El | undefined => {
			if (Array.isArray(node)) {
				for (const child of node) {
					const hit = findByType(child, target)
					if (hit) return hit
				}
				return undefined
			}
			if (!isElement(node)) return undefined
			if (node.type === target) return node
			return findByType(node.props.children, target)
		}

		beforeEach(() => {
			i18nMock.changeLanguage.mockReset()
			i18nMock.language = 'en'
		})

		it('Switches to the other language when clicked', () => {
			const button = findByType(LanguageToggle() as ReactElement, Button)
			button?.props.onClick?.()
			expect(i18nMock.changeLanguage).toHaveBeenCalledWith('sv')
		})

		it('Switches back from a regional variant of the current language', () => {
			i18nMock.language = 'sv-SE'
			const button = findByType(LanguageToggle() as ReactElement, Button)
			button?.props.onClick?.()
			expect(i18nMock.changeLanguage).toHaveBeenCalledWith('en')
		})

		it('Labels every language it can show, in both locales', () => {
			for (const locale of ['en', 'sv'] as const) {
				const values = loadLocale(locale)
				expect(values['language.action.switch'], locale).toBeTruthy()
				for (const language of languages)
					expect(values[`language.${language}`], locale).toBeTruthy()
			}
		})
	})
})
