import type { DetectorOptions } from 'i18next-browser-languagedetector'

/** The languages the portal ships — one locale file each under `public/locales` */
export const languages = ['en', 'sv'] as const
export type Language = (typeof languages)[number]

/** Used when nothing is stored and the browser asks for a language we do not ship */
export const defaultLanguage: Language = 'en'

/** Where the detector caches the picked language (a plain preference, no session data) */
export const languageStorageKey = 'language'

export const isLanguage = (value: unknown): value is Language =>
	typeof value === 'string' && (languages as readonly string[]).includes(value)

/** `sv-SE` → `sv`; anything we do not ship falls back to the default */
export const normalizeLanguage = (value: string | undefined | null): Language => {
	const base = value?.split('-')[0]?.toLowerCase()
	return isLanguage(base) ? base : defaultLanguage
}

/** The next language in the cycle — what the header toggle switches to */
export const nextLanguage = (current: string | undefined | null): Language =>
	languages[(languages.indexOf(normalizeLanguage(current)) + 1) % languages.length]!

/**
 * Unlike the public site the portal has no language in its URL, so the language comes from the
 * viewer: their stored choice first, the browser's `Accept-Language` next, and only then the
 * fallback. The choice is cached under `languageStorageKey` so it survives a reload.
 */
export const languageDetection: DetectorOptions = {
	order: ['localStorage', 'navigator'],
	caches: ['localStorage'],
	lookupLocalStorage: languageStorageKey,
}
