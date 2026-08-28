import fp from 'fastify-plugin'
import {
	canTransitionLifecycle,
	lifecycleActionMode,
	lifecycleActionTarget,
} from '@mf/models'

import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'
import { customerSlugForOrg } from '#/lib/customerSlug.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { LifecycleAction, LifecycleState, Order, Org } from '@mf/models'
import type { DeprovisionResult } from '@mf/org'

/** Outcome of the onboarding account-vend step. */
export type ProvisionResult = {
	/** True when the step did nothing (flag off, or an account was already recorded). */
	skipped: boolean
	/** Why it was skipped, for the log / response. */
	reason?: string
	org: Org
	/** The vended (or reused) account id, when a vend actually ran. */
	accountId?: string
	/** True when an existing account for the slug was reused rather than created. */
	reused?: boolean
}

/** Outcome of an admin/scheduler lifecycle action. */
export type LifecycleActionResult = {
	action: LifecycleAction
	/** True for the default preview run (nothing was torn down and the state did not change). */
	dryRun: boolean
	/** The order after the action (unchanged on a dry-run). */
	order: Order
	from: LifecycleState
	to: LifecycleState
	/** True when the DB lifecycle state was actually written (a confirmed, non-idempotent move). */
	applied: boolean
	/** The @mf/org deprovision result; absent when the order has no delivery to act on. */
	deprovision?: DeprovisionResult
}

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * Per-customer AWS account onboarding + delivery deprovisioning lifecycle (org-accounts.md,
		 * teardown-deprovisioning.md). Wraps the @mf/org seam (`app.org`) with the DB bookkeeping:
		 * records the vended account on the org, and drives an order's `active | suspended |
		 * torn_down` lifecycle, deprovisioning the tagged AWS resources as it goes.
		 */
		accountService: {
			/**
			 * Onboarding step: vend (or reuse) the customer's AWS account and record it on the org.
			 * Behind the `PROVISION_CUSTOMER_ACCOUNTS` flag — a no-op that records nothing until
			 * enabled, and a no-op when an account is already recorded (idempotent).
			 */
			provisionCustomerAccount: (orgId: string) => Promise<ProvisionResult>
			/**
			 * Suspend / resume / tear down an order's delivery. DRY-RUN unless `confirm: true`: a
			 * dry-run previews the deprovision and leaves the lifecycle untouched; a confirmed run
			 * deprovisions the tagged resources (fenced to the order's `Customer=<slug>`) and writes
			 * the new lifecycle state. Refuses a transition the state machine disallows (e.g. resuming
			 * a torn-down order).
			 */
			runLifecycleAction: (
				orderId: string,
				action: LifecycleAction,
				options?: { confirm?: boolean; label?: string }
			) => Promise<LifecycleActionResult>
		}
	}
}

const plugin: FastifyPluginAsync = async app => {
	const { db, org, secrets } = app

	const provisionCustomerAccount: FastifyInstance['accountService']['provisionCustomerAccount'] =
		async orgId => {
			const existing = await db.users.getOrg(orgId)
			if (!existing) throw new EntityNotFound('org', orgId)

			if (existing.awsAccountId) {
				return { skipped: true, reason: 'account already recorded', org: existing }
			}
			if (!secrets.provisionAccounts) {
				return { skipped: true, reason: 'PROVISION_CUSTOMER_ACCOUNTS is off', org: existing }
			}

			const slug = customerSlugForOrg(existing)
			const { accountId, reused } = await org.vend(slug)
			const updated = (await db.users.linkAwsAccount(orgId, { accountId, slug })) ?? existing
			app.log.info({ orgId, accountId, slug, reused }, 'Provisioned customer AWS account')
			return { skipped: false, org: updated, accountId, reused }
		}

	const runLifecycleAction: FastifyInstance['accountService']['runLifecycleAction'] = async (
		orderId,
		action,
		options
	) => {
		const order = await db.orders.getOrder(orderId)
		if (!order) throw new EntityNotFound('order', orderId)

		const from = order.lifecycle
		const to = lifecycleActionTarget[action]
		if (!canTransitionLifecycle(from, to)) throw new EntityInvalid('lifecycle', orderId)

		const dryRun = !(options?.confirm ?? false)
		const label = options?.label ?? order.name

		// Only a delivered order carries a fence slug; without one there is no compute to act on, so
		// deprovision is skipped and only the DB lifecycle transition (on confirm) applies.
		const deprovision = order.customerSlug
			? await org.deprovision(
					{ customerSlug: order.customerSlug, label },
					lifecycleActionMode[action],
					{ dryRun }
				)
			: undefined

		if (dryRun) {
			return { action, dryRun: true, order, from, to, applied: false, deprovision }
		}

		const updated = await db.orders.setLifecycle(orderId, [from], to)
		const applied = Boolean(updated) && from !== to
		app.log.info({ orderId, action, from, to, applied }, 'Lifecycle action applied')
		return { action, dryRun: false, order: updated ?? order, from, to, applied, deprovision }
	}

	app.decorate('accountService', { provisionCustomerAccount, runLifecycleAction })
}

export default fp(plugin, {
	name: '#internal/accountService',
	dependencies: ['#internal/db', '#internal/org', '#internal/secrets'],
})
