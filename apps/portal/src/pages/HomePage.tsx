import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { Has } from '#/layouts/Has.tsx'

export function HomePage() {
	const { t } = useTranslation()

	return (
		<>
			<h1>{t('page.home.title')}</h1>
			<p>{t('page.home.body')}</p>
			<p>
				<Link to="/orders">{t('page.home.action.orders')}</Link>
			</p>
			<Has permissions={['job:admin']}>
				<p>
					<Link to="/admin">{t('page.admin.title')}</Link>
				</p>
			</Has>
		</>
	)
}
