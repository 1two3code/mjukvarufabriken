import styles from './ShowcaseGallery.module.css'

import { useTranslation } from 'react-i18next'

import { useSiteRoute } from '#/hooks/useSiteRoute.ts'
import { useGetShowcasesQuery } from '#/features/showcases/showcasesApiSlice.ts'

import { Card, Grid } from '#/components/Section.tsx'
import { Spinner } from '#/components/Spinner.tsx'

import type { ShowcaseItem } from '@mf/models'
import type { Language } from '#/app/routes.ts'

/** The blurb in the page's language, falling back to the other one when the admin left it empty */
const blurbIn = (item: ShowcaseItem, language: Language) =>
	item.blurb[language] || item.blurb[language === 'sv' ? 'en' : 'sv']

/** The published demo apps as cards — every state (loading, error, empty) still renders copy */
export function ShowcaseGallery() {
	const { t } = useTranslation()
	const { language } = useSiteRoute()
	const { data, isLoading, isError } = useGetShowcasesQuery()

	if (isLoading) return <Spinner center />
	if (isError) {
		return (
			<p className={styles.state} role="alert">
				{t('demos.error')}
			</p>
		)
	}

	const items = data?.items ?? []
	if (!items.length) return <p className={styles.state}>{t('demos.empty')}</p>

	return (
		<Grid columns={3}>
			{items.map(item => (
				<Card key={item.orderId} title={item.title}>
					<p className={styles.blurb}>{blurbIn(item, language)}</p>
					<a className={styles.link} href={item.url} target="_blank" rel="noopener noreferrer">
						{t('demos.action.open')} ↗
					</a>
				</Card>
			))}
		</Grid>
	)
}
