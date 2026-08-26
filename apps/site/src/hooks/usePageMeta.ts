import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

const setMeta = (name: string, content: string) => {
	const meta = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)
	if (meta) meta.content = content
}

/**
 * Syncs `<title>` and the meta description with the given translation keys — re-runs when the
 * language changes since `t` is language-bound.
 */
export function usePageMeta(titleKey: string, descriptionKey: string) {
	const { t } = useTranslation()
	const title = t(titleKey)
	const description = t(descriptionKey)

	useEffect(() => {
		document.title = `${title} · ${import.meta.env.VITE_APP_TITLE}`
		setMeta('description', description)
	}, [title, description])
}
