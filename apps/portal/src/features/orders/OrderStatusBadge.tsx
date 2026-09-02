import styles from './OrderStatusBadge.module.css'

import { useTranslation } from 'react-i18next'

import type { HostingStatus, OrderStatus } from '@mf/models'

type OrderStatusBadgeProps = {
	status: OrderStatus
	/** What the customer actually got; a `delivered` order without a preview says so (F7) */
	hosting?: HostingStatus
}

const tone: Record<OrderStatus, string> = {
	drafting: styles.neutral,
	ready: styles.info,
	frozen: styles.info,
	deposit_paid: styles.info,
	building: styles.active,
	awaiting_approval: styles.active,
	delivered: styles.success,
	paid: styles.success,
	cancelled: styles.error,
}

export function OrderStatusBadge({ status, hosting }: OrderStatusBadgeProps) {
	const { t } = useTranslation()
	const unhosted = status === 'delivered' && hosting === 'unhosted'
	return (
		<span className={[styles.badge, unhosted ? styles.caution : tone[status]].join(' ')}>
			{t(unhosted ? 'order.status.deliveredUnhosted' : `order.status.${status}`)}
		</span>
	)
}
