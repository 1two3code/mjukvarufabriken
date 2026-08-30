import styles from './OrderStepper.module.css'

import { useTranslation } from 'react-i18next'

import type { OrderStatus } from '@mf/models'

type OrderStepperProps = {
	status: OrderStatus
}

/** The customer journey: spec → freeze → deposit → build → delivery → balance */
export const orderSteps = ['spec', 'freeze', 'deposit', 'build', 'delivery', 'balance'] as const
export type OrderStep = (typeof orderSteps)[number]

/** Index of the step the order is currently on (the last completed one is everything before) */
const currentStepIndex: Record<OrderStatus, number> = {
	drafting: 0,
	ready: 1,
	frozen: 2,
	deposit_paid: 3,
	building: 3,
	awaiting_approval: 4,
	delivered: 5,
	paid: 6,
	cancelled: -1,
}

export function OrderStepper({ status }: OrderStepperProps) {
	const { t } = useTranslation()
	const current = currentStepIndex[status]

	return (
		<ol className={styles.stepper} aria-label={t('order.stepper.label')}>
			{orderSteps.map((step, index) => {
				const state =
					status === 'cancelled'
						? styles.cancelled
						: index < current
							? styles.done
							: index === current
								? styles.current
								: styles.upcoming
				return (
					<li key={step} className={[styles.step, state].join(' ')}>
						<span className={styles.index}>{index + 1}</span>
						<span className={styles.title}>{t(`order.step.${step}`)}</span>
					</li>
				)
			})}
		</ol>
	)
}
