import styles from './OrderStatusBadge.module.css'

import { useTranslation } from 'react-i18next'

import type { OrderStatus } from '@mf/models'

type OrderStatusBadgeProps = {
	status: OrderStatus
}

const tone: Record<OrderStatus, string> = {
	drafting: styles.neutral,
	ready: styles.info,
	frozen: styles.info,
	deposit_paid: styles.info,
	building: styles.active,
	delivered: styles.success,
	paid: styles.success,
	cancelled: styles.error,
}

export function OrderStatusBadge({ status }: OrderStatusBadgeProps) {
	const { t } = useTranslation()
	return (
		<span className={[styles.badge, tone[status]].join(' ')}>{t(`order.status.${status}`)}</span>
	)
}
