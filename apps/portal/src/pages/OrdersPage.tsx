import styles from './OrdersPage.module.css'

import { useTranslation } from 'react-i18next'

import { NewOrderForm } from '#/features/orders/NewOrderForm.tsx'
import { OrderList } from '#/features/orders/OrderList.tsx'

import { Has } from '#/layouts/Has.tsx'

export function OrdersPage() {
	const { t } = useTranslation()

	return (
		<>
			<h1>{t('page.orders.title')}</h1>
			<p className={styles.intro}>{t('page.orders.intro')}</p>
			<div className={styles.toolbar}>
				<Has permissions={['spec:write']}>
					<NewOrderForm />
				</Has>
			</div>
			<OrderList />
		</>
	)
}
