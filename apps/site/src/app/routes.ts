export const languages = ['sv', 'en'] as const
export type Language = (typeof languages)[number]

export const defaultLanguage: Language = 'sv'

export const pages = ['home', 'howItWorks', 'pricing', 'contact'] as const
export type Page = (typeof pages)[number]

/** Every page has one path per language; Swedish is the default and lives at the root */
export const pagePaths: Record<Page, Record<Language, string>> = {
	home: { sv: '/', en: '/en' },
	howItWorks: { sv: '/sa-funkar-det', en: '/how-it-works' },
	pricing: { sv: '/priser', en: '/pricing' },
	contact: { sv: '/kontakt', en: '/contact' },
}

/** Data attached to each route via its `handle`, read by the layout to sync language + meta */
export type RouteHandle = { language: Language; page: Page }

export const isLanguage = (value: unknown): value is Language =>
	languages.includes(value as Language)

const normalizePath = (pathname: string) =>
	pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname

/** Language of a path (before the router has matched anything), default for unknown paths */
export const languageFromPath = (pathname: string): Language => {
	const path = normalizePath(pathname)
	for (const paths of Object.values(pagePaths)) {
		const match = languages.find(language => paths[language] === path)
		if (match) return match
	}
	return defaultLanguage
}
