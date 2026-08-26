import { useLocation, useMatches } from 'react-router-dom'

import { languageFromPath, pagePaths } from '#/app/routes.ts'

import type { Language, Page, RouteHandle } from '#/app/routes.ts'

const isRouteHandle = (handle: unknown): handle is RouteHandle =>
	typeof handle === 'object' && handle != null && 'language' in handle && 'page' in handle

/**
 * The language and page of the current route (from the route `handle`), plus path helpers
 * so links and the language toggle stay in the current language. Unknown routes (404)
 * have no page and take their language from the URL (`/en/...` stays English).
 */
export function useSiteRoute() {
	const matches = useMatches()
	const { pathname } = useLocation()
	const handle = matches.map(match => match.handle).find(isRouteHandle)
	const language = handle?.language ?? languageFromPath(pathname)
	const page = handle?.page

	const pathTo = (target: Page, targetLanguage: Language = language) =>
		pagePaths[target][targetLanguage]

	/** Same page in another language (home when there is no current page) */
	const pathInLanguage = (targetLanguage: Language) => pathTo(page ?? 'home', targetLanguage)

	return { language, page, pathTo, pathInLanguage }
}
