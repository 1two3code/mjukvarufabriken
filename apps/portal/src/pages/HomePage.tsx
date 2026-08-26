import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { Has } from '#/layouts/Has.tsx'

export function HomePage() {
	const { t } = useTranslation()

	return (
		<>
			<h1>{t('page.home.title')}</h1>
			<p>{t('page.home.body')}</p>
			<Has permissions={['spec:write']}>
				<p>
					<Link to="/orders/demo/spec">{t('page.home.action.newOrderDemo')}</Link>
				</p>
			</Has>
		</>
	)
}
