import type { OrderDetail } from '@mf/models'

/** Keys under `order.next.*`: what the customer should do (or wait for) next */
export type NextStep =
	| 'spec'
	| 'freeze'
	| 'deposit'
	| 'starting'
	| 'demoApproval'
	| 'building'
	| 'approval'
	| 'balance'
	| 'done'
	| 'cancelled'

/**
 * What the customer should do next, per status. A paid voucher demo (wave 14) waits for an admin
 * to approve its build — the stepper stays on the build step, only the copy differs — until the
 * approval is stamped, after which it is starting like any paid order.
 */
export const nextStep = (detail: OrderDetail): NextStep => {
	const { order, spec } = detail
	switch (order.status) {
		case 'drafting':
			return spec.complete ? 'freeze' : 'spec'
		case 'ready':
			return 'freeze'
		case 'frozen':
			return 'deposit'
		case 'deposit_paid':
			return order.kind === 'demo' && !order.buildApprovedAt ? 'demoApproval' : 'starting'
		case 'building':
			return 'building'
		case 'awaiting_approval':
			return 'approval'
		case 'delivered':
			return 'balance'
		case 'paid':
			return 'done'
		case 'cancelled':
			return 'cancelled'
	}
}
