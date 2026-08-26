import { useMatches } from 'react-router-dom'

import { defaultLanguage, pagePaths } from '#/app/routes.ts'

import type { Language, Page, RouteHandle } from '#/app/routes.ts'

const isRouteHandle = (handle: unknown): handle is RouteHandle =>
	typeof handle === 'object' && handle != null && 'language' in handle && 'page' in handle

/**
 * The language and page of the current route (from the route `handle`), plus path helpers
 * so links and the language toggle stay in the current language. Unknown routes (404)
 * fall back to the default language and no page.
 */
export function useSiteRoute() {
	const matches = useMatches()
	const handle = matches.map(match => match.handle).find(isRouteHandle)
	const language = handle?.language ?? defaultLanguage
	const page = handle?.page

	const pathTo = (target: Page, targetLanguage: Language = language) =>
		pagePaths[target][targetLanguage]

	/** Same page in another language (home when there is no current page) */
	const pathInLanguage = (targetLanguage: Language) => pathTo(page ?? 'home', targetLanguage)

	return { language, page, pathTo, pathInLanguage }
}
