import styles from './BuiltBy.module.css'

import { useTranslation } from 'react-i18next'

/**
 * The delivery standard: every application built by Mjukvaruhuset carries this one-line caption
 * footer linking back to mjukvaruhuset.se. It is mounted in `App.tsx` OUTSIDE the router, so a
 * rewrite of the layouts or routes never drops it — keep it there. A normal document-flow footer
 * under the app content, never fixed to the viewport.
 *
 * Hidden when `VITE_BUILT_BY_URL` is empty: a customer who no longer wants the caption removes it
 * with one line in `apps/app/.env` (`VITE_BUILT_BY_URL=`), no code change needed.
 */
export function BuiltBy() {
	const { t } = useTranslation()
	const url = import.meta.env.VITE_BUILT_BY_URL
	if (!url) return null

	return (
		<footer className={styles.footer}>
			<a className={styles.link} href={url} target="_blank" rel="noopener noreferrer">
				{t('builtBy.caption')}
			</a>
		</footer>
	)
}
