import styles from './SpecPage.module.css'

import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'

import { useGetSpecQuery } from '#/features/spec/specApiSlice.ts'
import { FreezeButton } from '#/features/spec/FreezeButton.tsx'
import { SpecChat } from '#/features/spec/SpecChat.tsx'
import { SpecPreview } from '#/features/spec/SpecPreview.tsx'

import { Spinner } from '#/components/Spinner.tsx'

export function SpecPage() {
	const { t } = useTranslation()
	const { orderId = '' } = useParams()
	const { data: draft, isLoading, isError } = useGetSpecQuery(orderId, { skip: !orderId })

	if (isLoading) return <Spinner center />
	if (isError || !draft) return <p className={styles.error}>{t('spec.page.loadError')}</p>

	return (
		<>
			<h1>{t('spec.page.title', { orderId })}</h1>
			<p className={styles.intro}>{t('spec.page.intro')}</p>
			<div className={styles.layout}>
				<SpecChat draft={draft} />
				<aside className={styles.side}>
					<SpecPreview draft={draft} />
					<FreezeButton draft={draft} />
				</aside>
			</div>
		</>
	)
}
