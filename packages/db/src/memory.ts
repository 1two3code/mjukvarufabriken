/**
 * In-memory implementation of the repositories — the api uses it when no database is
 * configured (local dev without docker) and in its tests, so the SQL layer and the services
 * share one contract. Behaviour mirrors the Postgres rules that services rely on: killed jobs
 * are terminal, one active job per order (rejects with `code: '23505'`), single-use magic
 * links and refresh tokens. Everything is lost when the process exits.
 */
import { isActiveJobStatus, isOrderSpecFrozen, pricesEffectiveAt, toSpecStatus } from '@mf/models'

import { nullTaskArnSweepSlackMinutes } from './jobs.ts'
import { defaultModelPriceRows } from './modelPrices.ts'
import { rateLimitRetentionMs } from './rateLimits.ts'
import { toShowcaseItem } from './showcases.ts'

import type {
	DeployedService,
	IterationBrief,
	IterationBriefEntry,
	Job,
	JobEvent,
	ModelPriceRow,
	Order,
	OrderKind,
	OrderStatus,
	Org,
	Payment,
	PricingTierRow,
	ResidentInstallation,
	ResidentUsageRecord,
	ResidentUsageReport,
	ResidentUsageSummary,
	Showcase,
	SpecDraft,
	User,
} from '@mf/models'
import type {
	MagicLink,
	NewOrg,
	NewUser,
	RefreshToken,
	Repositories,
	ResidentUsageFilter,
} from './repositories.ts'

/** What an order row holds in memory: the order record plus the draft's spec-phase fields */
type OrderEntry = {
	order: Order
	draft: Omit<SpecDraft, 'status'>
}

const toDraft = (entry: OrderEntry): SpecDraft => ({
	...entry.draft,
	status: toSpecStatus(entry.order.status),
})

const clone = <T>(value: T): T => structuredClone(value)
const now = () => new Date().toISOString()

/** Mimics the driver's unique-violation error (`jobs_one_active_per_order`, `users_email_key`) */
export class UniqueViolation extends Error {
	code = '23505'
	constructor(constraint: string) {
		super(`duplicate key value violates unique constraint "${constraint}"`)
	}
}

/** Upper bound on tracked keys per scope; beyond it the oldest keys are evicted (memory guard) */
export const memoryRateLimitMaxKeys = 10_000
/**
 * Hits older than this are dropped on every `record` — longer than any window a service counts over.
 * Aliases {@link rateLimitRetentionMs} so the in-memory sweep and the Postgres pruner share one
 * literal and cannot drift.
 */
export const memoryRateLimitRetentionMs = rateLimitRetentionMs

export type MemoryRepositories = Repositories & {
	rateLimits: Repositories['rateLimits'] & {
		/** Number of tracked keys in the scope (for tests) */
		size: (scope: string) => number
	}
}

export const createMemoryRepositories = (): MemoryRepositories => {
	const jobs = new Map<string, Job>()
	const modelPrices: ModelPriceRow[] = defaultModelPriceRows()
	/** Unseeded — no default pricing tiers, unlike the model-price list-price seed */
	const pricingTiers: PricingTierRow[] = []
	const events: JobEvent[] = []
	/** report token hash → job id (the hash is never part of the `Job` model) */
	const reportTokens = new Map<string, string>()
	/** `${jobId}:${seq}` → the event stored for that number (idempotent container events) */
	const numberedEvents = new Map<string, JobEvent>()
	const orders = new Map<string, OrderEntry>()
	/** order id → its demo-gallery row (0023) */
	const showcases = new Map<string, Showcase>()
	/** Every recorded deployed service, keyed by its own id (live rows have `deletedAt` undefined) */
	const deployedServices = new Map<string, DeployedService>()
	const payments = new Map<string, Payment>()
	const paymentEvents = new Set<string>()
	const users = new Map<string, User>()
	const orgs = new Map<string, Org>()
	const magicLinks = new Map<string, MagicLink>()
	const refreshTokens = new Map<string, RefreshToken>()
	const installations = new Map<string, ResidentInstallation>()
	/** `installationId/day` → record */
	const usage = new Map<string, ResidentUsageRecord>()
	/** `installationId/month` → report */
	const usageReports = new Map<string, ResidentUsageReport>()
	/** `orgId/projectId` → iteration brief */
	const iterationBriefs = new Map<string, IterationBrief>()
	/** scope → key → hit times (ms); keys are kept in insertion order for eviction */
	const rateLimits = new Map<string, Map<string, number[]>>()
	/** scope → when the retention sweep last ran (ms), so it runs at most once a minute */
	const rateLimitSweptAt = new Map<string, number>()
	/** When the auth sweep last ran (ms), so it runs at most once a minute */
	let authSweptAt = 0

	const byCreatedDesc = <T extends { createdAt: string }>(items: T[]) =>
		items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

	// MARK: Orders helpers
	const isSpecPhase = (status: OrderStatus) =>
		status === 'drafting' || status === 'ready' || status === 'frozen'
	const createOrder = (
		order: { id: string; orgId: string; name: string; createdBy?: string; kind?: OrderKind },
		status: OrderStatus
	): Order => ({
		id: order.id,
		orgId: order.orgId,
		name: order.name,
		status,
		kind: order.kind ?? 'build',
		approveBeforeDeliver: false,
		lifecycle: 'active',
		createdBy: order.createdBy,
		createdAt: now(),
		updatedAt: now(),
	})
	/** Price/size/frozenAt live on the order record; the draft mirrors them */
	const applyDraftFields = (order: Order, draft: Omit<SpecDraft, 'status'>) => {
		order.sizeClass = draft.spec.sizeClass
		order.priceSek = draft.priceSek
		order.frozenAt = draft.frozenAt
	}
	const listEntries = (filter: { orgId?: string }) =>
		[...orders.values()]
			.filter(entry => filter.orgId === undefined || entry.order.orgId === filter.orgId)
			.sort((a, b) => b.order.createdAt.localeCompare(a.order.createdAt))

	// MARK: Showcases helpers
	/** Gallery order: `sort` ascending, then the most recently changed first (as the SQL reads) */
	const sortShowcases = (rows: Showcase[]) =>
		rows.sort((a, b) => a.sort - b.sort || b.updatedAt.localeCompare(a.updatedAt))

	// Mirrors `users_email_key` (0001): one user per email. The helpers are synchronous so
	// `insertWithOrg` is atomic like the SQL transaction (no interleaving between the checks)
	const assertEmailFree = (email: string) => {
		if ([...users.values()].some(existing => existing.email === email)) {
			throw new UniqueViolation('users_email_key')
		}
	}
	// Mirrors `users_github_id_key` (0011): one user per GitHub account
	const assertGithubIdFree = (githubId: string | undefined, exceptId?: string) => {
		if (
			githubId !== undefined &&
			[...users.values()].some(
				existing => existing.githubId === githubId && existing.id !== exceptId
			)
		) {
			throw new UniqueViolation('users_github_id_key')
		}
	}
	const createUser = (user: NewUser): User => {
		assertEmailFree(user.email)
		assertGithubIdFree(user.githubId)
		const created: User = {
			id: crypto.randomUUID(),
			email: user.email,
			name: user.name,
			role: user.role,
			orgId: user.orgId,
			githubId: user.githubId,
			githubLogin: user.githubLogin,
			createdAt: now(),
		}
		users.set(created.id, created)
		return clone(created)
	}
	const createOrg = (org: NewOrg): Org => {
		const created: Org = { id: crypto.randomUUID(), name: org.name, createdAt: now() }
		orgs.set(created.id, created)
		return clone(created)
	}

	// MARK: Resident helpers
	const ensureInstallation = (id: string) => {
		const existing = installations.get(id)
		if (existing) return existing
		const created: ResidentInstallation = { id, createdAt: now(), updatedAt: now() }
		installations.set(id, created)
		return created
	}
	const matchesUsage = (record: ResidentUsageRecord, filter: ResidentUsageFilter) =>
		(filter.installationId === undefined || record.installationId === filter.installationId) &&
		(filter.month === undefined || record.month === filter.month)
	/** Mirrors the SQL group-by: sums per installation and month, cap view from the latest day */
	const summarize = (records: ResidentUsageRecord[]): ResidentUsageSummary => {
		const latest = records.toSorted((a, b) => b.day.localeCompare(a.day))[0]!
		const sum = (pick: (record: ResidentUsageRecord) => number) =>
			records.reduce((total, record) => total + pick(record), 0)
		return {
			installationId: latest.installationId,
			orgId: installations.get(latest.installationId)?.orgId,
			repository: latest.repository,
			month: latest.month,
			days: records.length,
			totalTokens: sum(record => record.totalTokens),
			listPriceUsd: sum(record => record.cost.listPriceUsd),
			billableUsd: sum(record => record.cost.billableUsd),
			tasks: {
				started: sum(record => record.tasks.started),
				succeeded: sum(record => record.tasks.succeeded),
				failed: sum(record => record.tasks.failed),
				pullRequestsOpened: sum(record => record.tasks.pullRequestsOpened),
			},
			monthlyCap: clone(latest.monthlyCap),
		}
	}

	// MARK: Auth helpers
	/**
	 * Drops expired links and expired or long-revoked tokens — the same rule as `pruneAuth` —
	 * and returns how many rows it removed
	 */
	const sweepAuth = () => {
		const cutoff = Date.now()
		const weekAgo = cutoff - 7 * 24 * 60 * 60 * 1000
		let deleted = 0
		for (const [hash, link] of magicLinks) {
			if (Date.parse(link.expiresAt) < weekAgo && magicLinks.delete(hash)) deleted++
		}
		for (const [hash, token] of refreshTokens) {
			const revokedAt = token.revokedAt ? Date.parse(token.revokedAt) : undefined
			if (
				(Date.parse(token.expiresAt) < cutoff ||
					(revokedAt !== undefined && revokedAt < weekAgo)) &&
				refreshTokens.delete(hash)
			) {
				deleted++
			}
		}
		return deleted
	}
	/** Nothing schedules `auth.pruneExpired()` on the memory backend, so inserts sweep (at most
	 * once a minute) — otherwise every unclicked link and every rotated token would live forever */
	const sweepAuthIfDue = () => {
		const now = Date.now()
		if (now - authSweptAt < 60_000) return
		authSweptAt = now
		sweepAuth()
	}

	// MARK: Rate limits helpers
	/**
	 * Drops hits at or before `since` and keys left without any, so the map only holds keys with
	 * hits inside the retention. Returns how many hits it removed.
	 */
	const sweepRateLimits = (scope: string, since: number) => {
		const keys = rateLimits.get(scope)
		if (!keys) return 0
		let removed = 0
		for (const [key, times] of keys) {
			const recent = times.filter(time => time > since)
			removed += times.length - recent.length
			if (recent.length) keys.set(key, recent)
			else keys.delete(key)
		}
		return removed
	}

	/** Shared by `jobs.insert` and `jobs.insertRetry`: the one-active-per-order guard + creation */
	const createJobRow = (job: Parameters<Repositories['jobs']['insert']>[0]): Job => {
		const active = [...jobs.values()].some(
			existing => existing.orderId === job.orderId && isActiveJobStatus(existing.status)
		)
		if (active) throw new UniqueViolation('jobs_one_active_per_order')
		const created: Job = {
			id: crypto.randomUUID(),
			orderId: job.orderId,
			orgId: job.orgId,
			status: 'queued',
			spec: clone(job.spec),
			budget: clone(job.budget),
			tokensUsed: 0,
			createdAt: now(),
		}
		jobs.set(created.id, created)
		if (job.reportTokenHash) reportTokens.set(job.reportTokenHash, created.id)
		return created
	}

	/** Shared event append (returns the STORED row; callers clone what they hand out) */
	const pushJobEvent = (
		jobId: string,
		type: JobEvent['type'],
		payload: Record<string, unknown>
	): JobEvent => {
		const created: JobEvent = {
			id: events.length + 1,
			jobId,
			type,
			payload: clone(payload),
			createdAt: now(),
		}
		events.push(created)
		return created
	}

	return {
		modelPrices: {
			list: async () =>
				[...modelPrices]
					.sort(
						(a, b) =>
							b.effectiveFrom.localeCompare(a.effectiveFrom) ||
							a.modelPrefix.localeCompare(b.modelPrefix)
					)
					.map(clone),
			insert: async price => {
				const effectiveFrom = new Date(price.effectiveFrom ?? now()).toISOString()
				if (
					modelPrices.some(
						row => row.modelPrefix === price.modelPrefix && row.effectiveFrom === effectiveFrom
					)
				) {
					throw new UniqueViolation('model_prices_model_prefix_effective_from_key')
				}
				const row: ModelPriceRow = {
					id: `price-${modelPrices.length + 1}`,
					modelPrefix: price.modelPrefix,
					input: price.input,
					output: price.output,
					cacheRead: price.cacheRead,
					cacheWrite: price.cacheWrite,
					effectiveFrom,
					createdAt: now(),
				}
				modelPrices.push(row)
				return clone(row)
			},
			effectiveAt: async at => pricesEffectiveAt(modelPrices, at),
		},
		pricingTiers: {
			list: async () =>
				[...pricingTiers]
					.sort(
						(a, b) =>
							b.effectiveFrom.localeCompare(a.effectiveFrom) || a.tierKey.localeCompare(b.tierKey)
					)
					.map(clone),
			insert: async tier => {
				const effectiveFrom = new Date(tier.effectiveFrom ?? now()).toISOString()
				if (
					pricingTiers.some(
						row => row.tierKey === tier.tierKey && row.effectiveFrom === effectiveFrom
					)
				) {
					throw new UniqueViolation('pricing_tiers_tier_key_effective_from_key')
				}
				const row: PricingTierRow = {
					id: `tier-${pricingTiers.length + 1}`,
					tierKey: tier.tierKey,
					name: tier.name,
					price: tier.price,
					currency: tier.currency,
					description: tier.description,
					effectiveFrom,
					createdAt: now(),
				}
				pricingTiers.push(row)
				return clone(row)
			},
		},
		jobs: {
			insert: async job => clone(createJobRow(job)),
			// The memory driver is single-threaded, so row + events are atomic like the SQL txn
			// (and a throwing insert writes nothing — see `insertRetryJob` in jobs.ts)
			insertRetry: async (job, ofJob) => {
				const created = createJobRow(job)
				pushJobEvent(ofJob.id, 'retry', {
					retryJobId: created.id,
					...(ofJob.reason !== undefined && { reason: ofJob.reason }),
					tokensUsed: ofJob.tokensUsed,
				})
				pushJobEvent(created.id, 'retry', { ofJobId: ofJob.id, attempt: 2 })
				return clone(created)
			},
			get: async id => clone(jobs.get(id)),
			getByReportToken: async tokenHash => {
				const id = reportTokens.get(tokenHash)
				return id === undefined ? undefined : clone(jobs.get(id))
			},
			list: async (filter = {}) =>
				byCreatedDesc(
					[...jobs.values()]
						.filter(job => filter.orderId === undefined || job.orderId === filter.orderId)
						.filter(job => filter.orgId === undefined || job.orgId === filter.orgId)
						.map(clone)
				).slice(0, 200),
			listStuck: async olderThan =>
				byCreatedDesc(
					[...jobs.values()]
						.filter(job => {
							if (!isActiveJobStatus(job.status)) return false
							if (job.taskArn !== undefined) return new Date(job.createdAt) < olderThan
							// No task recorded: age alone judges — see `listStuckJobs` (jobs.ts)
							const budgetMs =
								(job.budget.maxDurationMinutes + nullTaskArnSweepSlackMinutes) * 60_000
							return (
								!job.awaitingApproval && new Date(job.createdAt).getTime() < Date.now() - budgetMs
							)
						})
						.map(clone)
				)
					.reverse()
					.slice(0, 200),
			update: async (id, update) => {
				const job = jobs.get(id)
				if (!job) return undefined
				if (update.status !== undefined && job.status === 'killed') return undefined
				if (update.reportTokenHash !== undefined) {
					for (const [hash, jobId] of reportTokens) if (jobId === id) reportTokens.delete(hash)
					if (update.reportTokenHash !== null) reportTokens.set(update.reportTokenHash, id)
				}
				const next: Job = {
					...job,
					status: update.status ?? job.status,
					tokensUsed: update.tokensUsed ?? job.tokensUsed,
					usage: update.usage ?? job.usage,
					costUsd: update.costUsd ?? job.costUsd,
					plan: update.plan ?? job.plan,
					reason: update.reason ?? job.reason,
					gates: update.gates ?? job.gates,
					gateWaivers: update.gateWaivers ?? job.gateWaivers,
					taskArn: update.taskArn ?? job.taskArn,
					repositoryUrl: update.repositoryUrl ?? job.repositoryUrl,
					// Delivery ends the approve-before-deliver hold: a delivered job clears both flags (W9)
					awaitingApproval:
						update.status === 'delivered'
							? false
							: update.awaitingApproval !== undefined
								? update.awaitingApproval
								: job.awaitingApproval,
					approved:
						update.status === 'delivered'
							? false
							: update.approved !== undefined
								? update.approved
								: job.approved,
					startedAt: update.startedAt?.toISOString() ?? job.startedAt,
					finishedAt: update.finishedAt?.toISOString() ?? job.finishedAt,
				}
				jobs.set(id, next)
				return clone(next)
			},
			appendEvent: async (jobId, event) => clone(pushJobEvent(jobId, event.type, event.payload)),
			appendEventOnce: async (jobId, seq, event) => {
				const key = `${jobId}:${seq}`
				const existing = numberedEvents.get(key)
				if (existing) return { event: clone(existing), duplicate: true }
				const created = pushJobEvent(jobId, event.type, event.payload)
				numberedEvents.set(key, created)
				return { event: clone(created), duplicate: false }
			},
			countEvents: async (jobId, type) =>
				events.filter(event => event.jobId === jobId && event.type === type).length,
			listEvents: async (jobId, afterId = 0) =>
				events
					.filter(event => event.jobId === jobId && event.id > afterId)
					.slice(0, 500)
					.map(clone),
		},

		orders: {
			get: async orderId => {
				const entry = orders.get(orderId)
				return entry && clone(toDraft(entry))
			},
			// Newest first, capped at 200 — the same contract as the SQL `listOrders`
			list: async (filter = {}) =>
				listEntries(filter)
					.slice(0, 200)
					.map(entry => clone(toDraft(entry))),
			upsert: async draft => {
				const existing = orders.get(draft.orderId)
				const { status, ...fields } = draft
				const order: Order = existing
					? {
							...existing.order,
							orgId: draft.orgId ?? existing.order.orgId,
							// A draft's status only moves an order still in its spec phase
							status: isSpecPhase(existing.order.status) ? status : existing.order.status,
							updatedAt: now(),
						}
					: createOrder({ id: draft.orderId, orgId: draft.orgId ?? '', name: '' }, status)
				applyDraftFields(order, fields)
				const entry: OrderEntry = { order, draft: clone(fields) }
				orders.set(draft.orderId, entry)
				return clone(toDraft(entry))
			},
			updateUnlessFrozen: async draft => {
				const existing = orders.get(draft.orderId)
				if (!existing || isOrderSpecFrozen(existing.order.status)) return undefined
				const { status, ...fields } = draft
				existing.order = { ...existing.order, status, updatedAt: now() }
				applyDraftFields(existing.order, fields)
				existing.draft = clone(fields)
				return clone(toDraft(existing))
			},

			insert: async order => {
				const created = createOrder(order, 'drafting')
				orders.set(order.id, {
					order: created,
					draft: {
						orderId: order.id,
						orgId: order.orgId,
						spec: {},
						messages: [],
						openQuestions: [],
					},
				})
				return clone(created)
			},
			getOrder: async orderId => clone(orders.get(orderId)?.order),
			listOrders: async (filter = {}) =>
				listEntries(filter)
					.slice(0, 200)
					.map(entry => clone(entry.order)),
			transition: async (orderId, from, to) => {
				const entry = orders.get(orderId)
				if (!entry || !from.includes(entry.order.status)) return undefined
				entry.order = { ...entry.order, status: to, updatedAt: now() }
				return clone(entry.order)
			},
			setApproveBeforeDeliver: async (orderId, enabled) => {
				const entry = orders.get(orderId)
				if (!entry) return undefined
				entry.order = { ...entry.order, approveBeforeDeliver: enabled, updatedAt: now() }
				return clone(entry.order)
			},
			setLifecycle: async (orderId, from, to) => {
				const entry = orders.get(orderId)
				if (!entry || !from.includes(entry.order.lifecycle)) return undefined
				entry.order = {
					...entry.order,
					lifecycle: to,
					lifecycleChangedAt: now(),
					updatedAt: now(),
				}
				return clone(entry.order)
			},
			setCustomerSlug: async (orderId, customerSlug) => {
				const entry = orders.get(orderId)
				if (!entry) return undefined
				entry.order = { ...entry.order, customerSlug, updatedAt: now() }
				return clone(entry.order)
			},
			listSuspendedBefore: async changedBefore =>
				[...orders.values()]
					.map(entry => entry.order)
					.filter(
						order =>
							order.lifecycle === 'suspended' &&
							order.lifecycleChangedAt !== undefined &&
							new Date(order.lifecycleChangedAt) < changedBefore
					)
					.sort((a, b) => (a.lifecycleChangedAt ?? '').localeCompare(b.lifecycleChangedAt ?? ''))
					.slice(0, 200)
					.map(clone),

			setHostingUntil: async (orderId, hostingUntil) => {
				const entry = orders.get(orderId)
				if (!entry) return undefined
				entry.order = {
					...entry.order,
					hostingUntil: hostingUntil?.toISOString(),
					updatedAt: now(),
				}
				return clone(entry.order)
			},
			setBuildApprovedAt: async (orderId, approvedAt) => {
				const entry = orders.get(orderId)
				if (!entry || entry.order.buildApprovedAt !== undefined) return undefined
				entry.order = {
					...entry.order,
					buildApprovedAt: approvedAt.toISOString(),
					updatedAt: now(),
				}
				return clone(entry.order)
			},
			listActiveWithHostingUntilBefore: async until =>
				[...orders.values()]
					.map(entry => entry.order)
					.filter(
						order =>
							order.lifecycle === 'active' &&
							order.hostingUntil !== undefined &&
							new Date(order.hostingUntil) <= until
					)
					.sort((a, b) => (a.hostingUntil ?? '').localeCompare(b.hostingUntil ?? ''))
					.slice(0, 200)
					.map(clone),
			countDemoApprovalsSince: async since =>
				[...orders.values()].filter(
					({ order }) =>
						order.kind === 'demo' &&
						order.buildApprovedAt !== undefined &&
						new Date(order.buildApprovedAt) >= since
				).length,

			insertPayment: async payment => {
				if ([...payments.values()].some(p => p.sessionId === payment.sessionId)) {
					throw new UniqueViolation('payments_session_id_key')
				}
				const created: Payment = {
					id: crypto.randomUUID(),
					status: 'pending',
					...payment,
					createdAt: now(),
				}
				payments.set(created.id, created)
				return clone(created)
			},
			getPayment: async id => clone(payments.get(id)),
			findPaymentBySession: async sessionId =>
				clone([...payments.values()].find(payment => payment.sessionId === sessionId)),
			listPayments: async orderId =>
				[...payments.values()]
					.filter(payment => payment.orderId === orderId)
					.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
					.map(clone),
			markPaymentPaid: async (id, paid) => {
				const payment = payments.get(id)
				if (!payment || payment.status !== 'pending') return undefined
				const alreadyPaid = [...payments.values()].some(
					other =>
						other.orderId === payment.orderId &&
						other.kind === payment.kind &&
						other.status === 'paid'
				)
				if (alreadyPaid) throw new UniqueViolation('payments_one_paid_per_kind')
				const next: Payment = { ...payment, ...paid, status: 'paid', paidAt: now() }
				payments.set(id, next)
				return clone(next)
			},
			recordPaymentEvent: async eventId => {
				if (paymentEvents.has(eventId)) return false
				paymentEvents.add(eventId)
				return true
			},
			forgetPaymentEvent: async eventId => {
				paymentEvents.delete(eventId)
			},

			listActiveOrgIds: async () => [
				...new Set(
					[...orders.values()]
						.map(entry => entry.order)
						.filter(
							order =>
								order.lifecycle === 'active' && order.status !== 'cancelled' && order.orgId !== ''
						)
						.map(order => order.orgId)
				),
			],
			sumPaidPaymentsByOrg: async () => {
				const totals = new Map<string, number>()
				for (const payment of payments.values()) {
					if (payment.status !== 'paid') continue
					const orgId = orders.get(payment.orderId)?.order.orgId
					if (orgId === undefined) continue
					totals.set(orgId, (totals.get(orgId) ?? 0) + payment.amountSek)
				}
				return [...totals.entries()].map(([orgId, amountSek]) => ({ orgId, amountSek }))
			},
		},

		showcases: {
			upsert: async showcase => {
				const existing = showcases.get(showcase.orderId)
				const next: Showcase = {
					orderId: showcase.orderId,
					published: showcase.published,
					title: showcase.title,
					blurbSv: showcase.blurbSv,
					blurbEn: showcase.blurbEn,
					url: showcase.url ?? undefined,
					sort: showcase.sort,
					createdAt: existing?.createdAt ?? now(),
					updatedAt: now(),
				}
				showcases.set(showcase.orderId, next)
				return clone(next)
			},
			getByOrder: async orderId => clone(showcases.get(orderId)),
			// Both lists mirror the SQL JOIN: a row whose order is gone is not listed
			list: async () =>
				sortShowcases([...showcases.values()])
					.flatMap(showcase => {
						const order = orders.get(showcase.orderId)?.order
						if (!order) return []
						return [
							{
								...clone(showcase),
								orderName: order.name,
								orderStatus: order.status,
								lifecycle: order.lifecycle,
							},
						]
					})
					.slice(0, 200),
			listPublished: async () =>
				sortShowcases([...showcases.values()])
					.flatMap(showcase => {
						const order = orders.get(showcase.orderId)?.order
						if (!showcase.published || showcase.url === undefined || !order) return []
						if (order.lifecycle !== 'active') return []
						return [toShowcaseItem({ ...showcase, url: showcase.url })]
					})
					.slice(0, 200),
		},

		deployedServices: {
			record: async service => {
				const existing = [...deployedServices.values()].find(
					row =>
						row.orderId === service.orderId &&
						row.serviceName === service.serviceName &&
						row.deletedAt === undefined
				)
				const created: DeployedService = {
					id: existing?.id ?? crypto.randomUUID(),
					orderId: service.orderId,
					jobId: service.jobId,
					serviceName: service.serviceName,
					serviceArn: service.serviceArn ?? undefined,
					customerTag: service.customerTag,
					image: service.image ?? undefined,
					config: service.config ?? undefined,
					createdAt: existing?.createdAt ?? now(),
				}
				deployedServices.set(created.id, created)
				return clone(created)
			},
			listForOrder: async orderId =>
				[...deployedServices.values()]
					.filter(row => row.orderId === orderId && row.deletedAt === undefined)
					.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
					.map(clone),
			setArn: async (id, serviceArn) => {
				const row = deployedServices.get(id)
				if (!row || row.deletedAt !== undefined) return undefined
				const next: DeployedService = { ...row, serviceArn: serviceArn ?? undefined }
				deployedServices.set(id, next)
				return clone(next)
			},
			markSuspended: async orderId => {
				let updated = 0
				for (const [id, row] of deployedServices) {
					if (row.orderId !== orderId || row.deletedAt !== undefined) continue
					deployedServices.set(id, { ...row, serviceArn: undefined })
					updated += 1
				}
				return updated
			},
			markTornDown: async orderId => {
				let updated = 0
				for (const [id, row] of deployedServices) {
					if (row.orderId !== orderId || row.deletedAt !== undefined) continue
					deployedServices.set(id, { ...row, deletedAt: now() })
					updated += 1
				}
				return updated
			},
		},

		users: {
			get: async id => clone(users.get(id)),
			findByEmail: async email => clone([...users.values()].find(user => user.email === email)),
			findByGithubId: async githubId =>
				clone([...users.values()].find(user => user.githubId === githubId)),
			insert: async user => createUser(user),
			linkGithub: async (id, identity) => {
				const user = users.get(id)
				if (!user) return undefined
				assertGithubIdFree(identity.githubId, id)
				user.githubId = identity.githubId
				user.githubLogin = identity.githubLogin
				user.name ??= identity.name
				return clone(user)
			},
			insertWithOrg: async (user, org) => {
				assertEmailFree(user.email)
				return createUser({ ...user, orgId: createOrg(org).id })
			},
			getOrg: async id => clone(orgs.get(id)),
			insertOrg: async org => createOrg(org),
			listOrgs: async () => byCreatedDesc([...orgs.values()].map(clone)),
			linkAwsAccount: async (orgId, account) => {
				const org = orgs.get(orgId)
				if (!org) return undefined
				org.awsAccountId = account.accountId
				org.awsAccountSlug = account.slug
				return clone(org)
			},
		},

		auth: {
			insertMagicLink: async link => {
				sweepAuthIfDue()
				const created: MagicLink = {
					tokenHash: link.tokenHash,
					email: link.email,
					purpose: link.purpose ?? 'email',
					createdAt: now(),
					expiresAt: link.expiresAt.toISOString(),
				}
				magicLinks.set(link.tokenHash, created)
				return clone(created)
			},
			getMagicLink: async tokenHash => clone(magicLinks.get(tokenHash)),
			consumeMagicLink: async tokenHash => {
				const link = magicLinks.get(tokenHash)
				if (!link || link.usedAt) return undefined
				link.usedAt = now()
				return clone(link)
			},
			countMagicLinksSince: async (email, since) =>
				[...magicLinks.values()].filter(
					link =>
						link.email === email && link.purpose === 'email' && new Date(link.createdAt) > since
				).length,
			insertRefreshToken: async token => {
				sweepAuthIfDue()
				const created: RefreshToken = {
					tokenHash: token.tokenHash,
					userId: token.userId,
					createdAt: now(),
					expiresAt: token.expiresAt.toISOString(),
				}
				refreshTokens.set(token.tokenHash, created)
				return clone(created)
			},
			consumeRefreshToken: async tokenHash => {
				const token = refreshTokens.get(tokenHash)
				if (!token || token.revokedAt) return undefined
				token.revokedAt = now()
				return clone(token)
			},
			revokeRefreshToken: async tokenHash => {
				const token = refreshTokens.get(tokenHash)
				if (token && !token.revokedAt) token.revokedAt = now()
			},
			pruneExpired: async () => sweepAuth(),
		},

		rateLimits: {
			count: async (scope, key, since) => {
				const keys = rateLimits.get(scope)
				if (!keys) return 0
				const recent = (times: number[]) => times.filter(time => time > since.getTime()).length
				if (key !== undefined) return recent(keys.get(key) ?? [])
				let total = 0
				for (const times of keys.values()) total += recent(times)
				return total
			},
			record: async (scope, key, at = new Date()) => {
				const now = at.getTime()
				if (now - (rateLimitSweptAt.get(scope) ?? 0) > 60_000) {
					sweepRateLimits(scope, now - memoryRateLimitRetentionMs)
					rateLimitSweptAt.set(scope, now)
				}
				const keys = rateLimits.get(scope) ?? new Map<string, number[]>()
				rateLimits.set(scope, keys)
				// Re-insert so the key moves to the end: Map iteration order == insertion order
				const times = keys.get(key) ?? []
				keys.delete(key)
				keys.set(key, [...times, at.getTime()])
				while (keys.size > memoryRateLimitMaxKeys) {
					const oldest = keys.keys().next().value
					if (oldest === undefined) break
					keys.delete(oldest)
				}
			},
			pruneExpired: async () => {
				const since = Date.now() - memoryRateLimitRetentionMs
				let removed = 0
				for (const scope of rateLimits.keys()) removed += sweepRateLimits(scope, since)
				return removed
			},
			size: scope => rateLimits.get(scope)?.size ?? 0,
		},

		resident: {
			getInstallation: async id => clone(installations.get(id)),
			listInstallations: async () => byCreatedDesc([...installations.values()].map(clone)),
			upsertInstallation: async upsert => {
				const existing = ensureInstallation(upsert.id)
				const next: ResidentInstallation = {
					...existing,
					orgId: upsert.orgId === undefined ? existing.orgId : (upsert.orgId ?? undefined),
					billingCustomerId:
						upsert.billingCustomerId === undefined
							? existing.billingCustomerId
							: (upsert.billingCustomerId ?? undefined),
					updatedAt: now(),
				}
				installations.set(upsert.id, next)
				return clone(next)
			},
			upsertUsage: async record => {
				ensureInstallation(record.installationId)
				usage.set(`${record.installationId}/${record.day}`, clone(record))
				return clone(record)
			},
			listUsage: async (filter = {}) =>
				[...usage.values()]
					.filter(record => matchesUsage(record, filter))
					.sort((a, b) => b.day.localeCompare(a.day))
					.slice(0, 1000)
					.map(clone),
			summarizeUsage: async (filter = {}) => {
				const groups = new Map<string, ResidentUsageRecord[]>()
				for (const record of usage.values()) {
					if (!matchesUsage(record, filter)) continue
					const key = `${record.installationId}/${record.month}`
					groups.set(key, [...(groups.get(key) ?? []), record])
				}
				return [...groups.values()]
					.map(summarize)
					.sort(
						(a, b) =>
							b.month.localeCompare(a.month) || a.installationId.localeCompare(b.installationId)
					)
			},
			getUsageReport: async (installationId, month) =>
				clone(usageReports.get(`${installationId}/${month}`)),
			listUsageReports: async month =>
				[...usageReports.values()]
					.filter(report => month === undefined || report.month === month)
					.sort(
						(a, b) =>
							b.month.localeCompare(a.month) || a.installationId.localeCompare(b.installationId)
					)
					.map(clone),
			upsertUsageReport: async report => {
				const next: ResidentUsageReport = {
					installationId: report.installationId,
					month: report.month,
					usdCents: report.usdCents,
					provider: report.provider,
					reference: report.reference,
					reportedAt: now(),
				}
				usageReports.set(`${report.installationId}/${report.month}`, next)
				return clone(next)
			},
			reserveUsageReport: async reservation => {
				const key = `${reservation.installationId}/${reservation.month}`
				const existing = usageReports.get(key)
				const sameProvider = existing?.provider === reservation.provider
				if (existing && sameProvider) {
					const retry = existing.pendingIdentifier === reservation.identifier
					if (existing.usdCents !== reservation.fromUsdCents) return undefined
					if (existing.pendingIdentifier !== undefined && !retry) return undefined
				}
				const next: ResidentUsageReport = {
					installationId: reservation.installationId,
					month: reservation.month,
					usdCents: sameProvider ? existing!.usdCents : 0,
					provider: reservation.provider,
					reference: sameProvider ? existing!.reference : undefined,
					pendingUsdCents: reservation.toUsdCents,
					pendingIdentifier: reservation.identifier,
					pendingAt: now(),
					reportedAt: existing?.reportedAt ?? now(),
				}
				usageReports.set(key, next)
				return clone(next)
			},
			confirmUsageReport: async (installationId, month, identifier, reference) => {
				const key = `${installationId}/${month}`
				const existing = usageReports.get(key)
				if (!existing || existing.pendingIdentifier !== identifier) return undefined
				const next: ResidentUsageReport = {
					installationId,
					month,
					usdCents: existing.pendingUsdCents ?? existing.usdCents,
					provider: existing.provider,
					reference,
					reportedAt: now(),
				}
				usageReports.set(key, next)
				return clone(next)
			},
			releaseUsageReport: async (installationId, month, identifier) => {
				const existing = usageReports.get(`${installationId}/${month}`)
				if (existing?.pendingIdentifier === identifier) delete existing.pendingAt
			},
		},

		iterationBrief: {
			get: async (orgId, projectId) => clone(iterationBriefs.get(`${orgId}/${projectId}`)),
			list: async orgId =>
				[...iterationBriefs.values()]
					.filter(brief => orgId === undefined || brief.orgId === orgId)
					.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
					.slice(0, 500)
					.map(clone),
			appendEntry: async (
				orgId: string,
				projectId: string,
				entry: IterationBriefEntry,
				title?: string
			) => {
				const key = `${orgId}/${projectId}`
				const existing = iterationBriefs.get(key)
				const next: IterationBrief = existing
					? { ...existing, entries: [...existing.entries, clone(entry)], updatedAt: now() }
					: {
							orgId,
							projectId,
							title,
							entries: [clone(entry)],
							createdAt: now(),
							updatedAt: now(),
						}
				iterationBriefs.set(key, next)
				return clone(next)
			},
		},
	}
}
