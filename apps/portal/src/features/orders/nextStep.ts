import type { OrderDetail } from '@mf/models'

/** Keys under `order.next.*`: what the customer should do (or wait for) next */
export type NextStep =
	| 'spec'
	| 'freeze'
	| 'deposit'
	| 'demoDeposit'
	| 'starting'
	| 'demoApproval'
	| 'building'
	| 'approval'
	| 'balance'
	| 'done'
	| 'cancelled'

/**
 * What the customer should do next, per status. A voucher demo (wave 14) pays its 500 kr upfront
 * and then waits for an admin to approve its build — the stepper stays on the deposit/build steps,
 * only the copy differs — until the approval is stamped, after which it is starting like any paid
 * order.
 */
export const nextStep = (detail: OrderDetail): NextStep => {
	const { order, spec } = detail
	switch (order.status) {
		case 'drafting':
			return spec.complete ? 'freeze' : 'spec'
		case 'ready':
			return 'freeze'
		case 'frozen':
			// A demo's 500 kr is paid upfront and its build waits for an approval — the ordinary
			// deposit copy ("the build starts automatically") would promise the opposite
			return order.kind === 'demo' ? 'demoDeposit' : 'deposit'
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
