import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import Backend from 'i18next-http-backend'
import { initReactI18next } from 'react-i18next'

import { defaultLanguage, languageDetection, languages, normalizeLanguage } from '#/app/language.ts'

import type { HttpBackendOptions } from 'i18next-http-backend'

// The portal has no language segment in its URL (the public site does), so the language comes from
// the viewer — their stored choice, then the browser — and is switched from the header toggle.
// eslint-disable-next-line no-restricted-syntax
export default i18n
	.use(Backend)
	.use(LanguageDetector)
	.use(initReactI18next)
	.init<HttpBackendOptions>({
		debug: import.meta.env.DEV,
		fallbackLng: defaultLanguage,
		supportedLngs: [...languages],
		// `sv-SE` from the browser must load our `sv` bundle, not ask the backend for `sv-SE.json`
		load: 'languageOnly',
		detection: languageDetection,
		backend: {
			loadPath: '/locales/{{lng}}.json',
			queryStringParams: { v: import.meta.env.VITE_APP_VERSION },
		},
	})

// index.html can only ship a static `lang`, so keep the document in sync with the real language:
// this fires once on init (after detection) and again on every switch.
i18n.on('languageChanged', language => {
	document.documentElement.lang = normalizeLanguage(language)
})

// Listen to i18n updates if hot is enabled
if (import.meta.hot) {
	import.meta.hot.on('i18n-update', async () => {
		await i18n.reloadResources()
		i18n.changeLanguage(i18n.language)
	})
}
