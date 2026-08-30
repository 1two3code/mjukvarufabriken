import fp from 'fastify-plugin'
import { allocateInfraCost } from '@mf/models'

import type { FastifyPluginAsync } from 'fastify'
import type { CustomerRevenue, InfraCostAllocation } from '@mf/models'

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * M12 margin calculator (backend only, PLAN.md M12; the admin UI is a fast-follow once the
		 * in-flight `/admin` refactor merges). Both figures are built from data the rest of the api
		 * already owns — no new payment flow, no new cost model beyond the phase-1 rough allocation.
		 */
		marginService: {
			/** Phase-1 rough infra-cost allocation: the shared platform estimate split across active orgs */
			infraCostAllocation: () => Promise<InfraCostAllocation>
			/** Build fee + hosting + SLA + further dev + resident tokens×1.5, per org */
			revenueByCustomer: () => Promise<CustomerRevenue[]>
		}
	}
}

const plugin: FastifyPluginAsync = async app => {
	const { db } = app

	app.decorate('marginService', {
		infraCostAllocation: async () => allocateInfraCost(await db.orders.listActiveOrgIds()),
		revenueByCustomer: async () => {
			const [orgs, buildFees, residentUsage] = await Promise.all([
				db.users.listOrgs(),
				db.orders.sumPaidPaymentsByOrg(),
				db.resident.summarizeUsage(),
			])
			const buildFeeByOrg = new Map(buildFees.map(row => [row.orgId, row.amountSek]))
			const residentByOrg = new Map<string, number>()
			for (const summary of residentUsage) {
				if (!summary.orgId) continue
				residentByOrg.set(
					summary.orgId,
					(residentByOrg.get(summary.orgId) ?? 0) + summary.billableUsd
				)
			}
			return orgs.map(org => ({
				orgId: org.id,
				orgName: org.name,
				buildFeeSek: buildFeeByOrg.get(org.id) ?? 0,
				hostingSek: 0,
				slaSek: 0,
				furtherDevSek: 0,
				residentBillableUsd: residentByOrg.get(org.id) ?? 0,
			}))
		},
	})
}

export default fp(plugin, {
	name: '#internal/marginService',
	dependencies: ['#internal/db'],
})
