import i18n from 'i18next'
import Backend from 'i18next-http-backend'
import { initReactI18next } from 'react-i18next'

import { defaultLanguage, languageFromPath, languages } from '#/app/routes.ts'

import type { HttpBackendOptions } from 'i18next-http-backend'

// The language is part of the URL (see routes.ts), so the first render already uses the right one
// eslint-disable-next-line no-restricted-syntax
export default i18n
	.use(Backend)
	.use(initReactI18next)
	.init<HttpBackendOptions>({
		debug: import.meta.env.DEV,
		lng: languageFromPath(window.location.pathname),
		fallbackLng: defaultLanguage,
		supportedLngs: [...languages],
		backend: {
			loadPath: '/locales/{{lng}}.json',
			queryStringParams: { v: import.meta.env.VITE_APP_VERSION },
		},
	})

// Listen to i18n updates if hot is enabled
if (import.meta.hot) {
	import.meta.hot.on('i18n-update', async () => {
		await i18n.reloadResources()
		i18n.changeLanguage(i18n.language)
	})
}
