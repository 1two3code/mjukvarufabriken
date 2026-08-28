/**
 * In-memory implementation of the repositories — the api uses it when no database is
 * configured (local dev without docker) and in its tests, so the SQL layer and the services
 * share one contract. Behaviour mirrors the Postgres rules that services rely on: killed jobs
 * are terminal, one active job per order (rejects with `code: '23505'`), single-use magic
 * links and refresh tokens. Everything is lost when the process exits.
 */
import { isActiveJobStatus, isOrderSpecFrozen, toSpecStatus } from '@mf/models'

import { rateLimitRetentionMs } from './rateLimits.ts'

import type {
	Job,
	JobEvent,
	Order,
	OrderStatus,
	Org,
	Payment,
	ResidentInstallation,
	ResidentUsageRecord,
	ResidentUsageReport,
	ResidentUsageSummary,
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
	const events: JobEvent[] = []
	/** report token hash → job id (the hash is never part of the `Job` model) */
	const reportTokens = new Map<string, string>()
	/** `${jobId}:${seq}` → the event stored for that number (idempotent container events) */
	const numberedEvents = new Map<string, JobEvent>()
	const orders = new Map<string, OrderEntry>()
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
		order: { id: string; orgId: string; name: string; createdBy?: string },
		status: OrderStatus
	): Order => ({
		id: order.id,
		orgId: order.orgId,
		name: order.name,
		status,
		approveBeforeDeliver: false,
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

	return {
		jobs: {
			insert: async job => {
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
						.filter(
							job =>
								isActiveJobStatus(job.status) &&
								job.taskArn !== undefined &&
								new Date(job.createdAt) < olderThan
						)
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
					plan: update.plan ?? job.plan,
					reason: update.reason ?? job.reason,
					gates: update.gates ?? job.gates,
					gateWaivers: update.gateWaivers ?? job.gateWaivers,
					taskArn: update.taskArn ?? job.taskArn,
					repositoryUrl: update.repositoryUrl ?? job.repositoryUrl,
					awaitingApproval:
						update.awaitingApproval !== undefined ? update.awaitingApproval : job.awaitingApproval,
					approved: update.approved !== undefined ? update.approved : job.approved,
					startedAt: update.startedAt?.toISOString() ?? job.startedAt,
					finishedAt: update.finishedAt?.toISOString() ?? job.finishedAt,
				}
				jobs.set(id, next)
				return clone(next)
			},
			appendEvent: async (jobId, event) => {
				const created: JobEvent = {
					id: events.length + 1,
					jobId,
					type: event.type,
					payload: clone(event.payload),
					createdAt: now(),
				}
				events.push(created)
				return clone(created)
			},
			appendEventOnce: async (jobId, seq, event) => {
				const key = `${jobId}:${seq}`
				const existing = numberedEvents.get(key)
				if (existing) return { event: clone(existing), duplicate: true }
				const created: JobEvent = {
					id: events.length + 1,
					jobId,
					type: event.type,
					payload: clone(event.payload),
					createdAt: now(),
				}
				events.push(created)
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
	}
}
