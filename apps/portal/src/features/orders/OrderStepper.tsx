import styles from './OrderStepper.module.css'

import { useTranslation } from 'react-i18next'
import { isFullUpfront } from '@mf/models'

import type { OrderStatus } from '@mf/models'

type OrderStepperProps = {
	status: OrderStatus
	/** Set once the spec is frozen; a full-upfront price drops the balance step */
	priceSek?: number
}

/** The customer journey: spec → freeze → deposit → build → delivery → balance */
export const orderSteps = ['spec', 'freeze', 'deposit', 'build', 'delivery', 'balance'] as const
export type OrderStep = (typeof orderSteps)[number]

/**
 * A full-upfront order (below the 3 000 kr threshold) pays everything in one Checkout: its
 * journey has a single `payment` step instead of deposit + balance (pricing ladder 2026-08-31).
 */
export const stepsFor = (priceSek?: number): readonly OrderStep[] =>
	priceSek !== undefined && isFullUpfront(priceSek)
		? orderSteps.filter(step => step !== 'balance')
		: orderSteps

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

export function OrderStepper({ status, priceSek }: OrderStepperProps) {
	const { t } = useTranslation()
	const current = currentStepIndex[status]
	const fullUpfront = priceSek !== undefined && isFullUpfront(priceSek)

	return (
		<ol className={styles.stepper} aria-label={t('order.stepper.label')}>
			{stepsFor(priceSek).map((step, index) => {
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
						<span className={styles.title}>
							{t(`order.step.${step === 'deposit' && fullUpfront ? 'payment' : step}`)}
						</span>
					</li>
				)
			})}
		</ol>
	)
}
