import { z } from 'zod'

/**
 * M12 margin calculator (admin, backend only — PLAN.md M12; the admin UI is a fast-follow once
 * the in-flight `/admin` refactor merges). Two rough numbers, not a real cost model yet:
 *  - infra cost allocation: our own shared platform infra (RDS/Fargate/ALB/NAT/S3 for the
 *    api/site/portal — NOT per-job build compute, which is already metered exactly per job, see
 *    `jobCostUsd`) split evenly across orgs currently being served. Phase 1 only: once M11's
 *    vended-member-account billing lands, a customer's own infra cost falls out of Cost Explorer
 *    per account instead of this allocation (PLAN.md M12).
 *  - revenue per customer: what the `orders`/`payments`/`resident_usage` tables already hold,
 *    reshaped per org — no new payment flow. `hostingSek` / `slaSek` / `furtherDevSek` are 0
 *    today: nothing in the schema records those payment kinds yet (hosting starts once M11's
 *    qa/live promotion ships, PLAN.md), the shape just carries the fields so a later payment
 *    kind slots straight in without another migration of this endpoint.
 */

// MARK: Infra cost allocation (phase 1 — "now")

/**
 * Rough monthly USD estimate of the shared platform infra, eu-north-1: our own RDS instance, the
 * always-on Fargate services (api/site/portal — not build-job compute), the shared ALB, the NAT
 * gateway and S3. Ballpark figures, not read from AWS Cost Explorer — edit here as better numbers
 * come in. Replaced by real per-account billing once M11's vended-member-account model ships.
 */
export const sharedInfraMonthlyCostUsd = {
	rds: 25,
	fargate: 45,
	alb: 20,
	nat: 35,
	s3: 5,
}

export const InfraCostBreakdownSchema = z.object({
	rds: z.number().nonnegative(),
	fargate: z.number().nonnegative(),
	alb: z.number().nonnegative(),
	nat: z.number().nonnegative(),
	s3: z.number().nonnegative(),
})

export const InfraCostAllocationSchema = z.object({
	/** Sum of `sharedInfraMonthlyCostUsd`'s components */
	totalMonthlyCostUsd: z.number().nonnegative(),
	breakdown: InfraCostBreakdownSchema,
	/** Orgs with a non-cancelled order still in the `active` deprovisioning lifecycle */
	activeOrgIds: z.array(z.string()),
	/** `totalMonthlyCostUsd` split across `activeOrgIds` (0 active orgs still returns the total, not Infinity) */
	perOrgMonthlyCostUsd: z.number().nonnegative(),
})
export type InfraCostAllocation = z.infer<typeof InfraCostAllocationSchema>

const round2 = (value: number) => Math.round(value * 100) / 100

/** Phase-1 allocation: the shared cost estimate split evenly across `activeOrgIds` */
export const allocateInfraCost = (activeOrgIds: string[]): InfraCostAllocation => {
	const totalMonthlyCostUsd = round2(
		Object.values(sharedInfraMonthlyCostUsd).reduce((sum, cost) => sum + cost, 0)
	)
	const divisor = Math.max(activeOrgIds.length, 1)
	return {
		totalMonthlyCostUsd,
		breakdown: sharedInfraMonthlyCostUsd,
		activeOrgIds,
		perOrgMonthlyCostUsd: round2(totalMonthlyCostUsd / divisor),
	}
}

// MARK: Revenue per customer

export const CustomerRevenueSchema = z.object({
	orgId: z.string(),
	orgName: z.string(),
	/** Sum of paid `deposit` + `balance` payments for the org's orders (`payments`, ex moms) */
	buildFeeSek: z.number().nonnegative(),
	/** Not yet a tracked payment flow — hosting revenue starts with M11's qa/live promotion */
	hostingSek: z.number().nonnegative(),
	/** Not yet a tracked payment flow */
	slaSek: z.number().nonnegative(),
	/** Not yet a tracked payment flow */
	furtherDevSek: z.number().nonnegative(),
	/** Sum of `resident_usage.billableUsd` across the org's installations (list price × `residentUsageMarkup`, USD) */
	residentBillableUsd: z.number().nonnegative(),
})
export type CustomerRevenue = z.infer<typeof CustomerRevenueSchema>

export const CustomerRevenueListResponseSchema = z.array(CustomerRevenueSchema)
