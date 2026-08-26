/**
 * In-memory implementation of the repositories — the api uses it when no database is
 * configured (local dev without docker) and in its tests, so the SQL layer and the services
 * share one contract. Behaviour mirrors the Postgres rules that services rely on: killed jobs
 * are terminal, one active job per order (rejects with `code: '23505'`), single-use magic
 * links and refresh tokens. Everything is lost when the process exits.
 */
import { isActiveJobStatus } from '@mf/models'

import type { Job, JobEvent, Org, SpecDraft, User } from '@mf/models'
import type { MagicLink, NewOrg, NewUser, RefreshToken, Repositories } from './repositories.ts'

const clone = <T>(value: T): T => structuredClone(value)
const now = () => new Date().toISOString()

/** Mimics the driver's unique-violation error (`jobs_one_active_per_order`, `users_email_key`) */
export class UniqueViolation extends Error {
	code = '23505'
	constructor(constraint: string) {
		super(`duplicate key value violates unique constraint "${constraint}"`)
	}
}

export const createMemoryRepositories = (): Repositories => {
	const jobs = new Map<string, Job>()
	const events: JobEvent[] = []
	/** report token hash → job id (the hash is never part of the `Job` model) */
	const reportTokens = new Map<string, string>()
	/** `${jobId}:${seq}` → the event stored for that number (idempotent container events) */
	const numberedEvents = new Map<string, JobEvent>()
	const orders = new Map<string, { draft: SpecDraft; createdAt: string }>()
	const users = new Map<string, User>()
	const orgs = new Map<string, Org>()
	const magicLinks = new Map<string, MagicLink>()
	const refreshTokens = new Map<string, RefreshToken>()

	const byCreatedDesc = <T extends { createdAt: string }>(items: T[]) =>
		items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

	// Mirrors `users_email_key` (0001): one user per email. The helpers are synchronous so
	// `insertWithOrg` is atomic like the SQL transaction (no interleaving between the checks)
	const assertEmailFree = (email: string) => {
		if ([...users.values()].some(existing => existing.email === email)) {
			throw new UniqueViolation('users_email_key')
		}
	}
	const createUser = (user: NewUser): User => {
		assertEmailFree(user.email)
		const created: User = {
			id: crypto.randomUUID(),
			email: user.email,
			name: user.name,
			role: user.role,
			orgId: user.orgId,
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
			get: async orderId => clone(orders.get(orderId)?.draft),
			// Newest first, capped at 200 — the same contract as the SQL `listOrders`
			list: async (filter = {}) =>
				byCreatedDesc(
					[...orders.values()].filter(
						row => filter.orgId === undefined || row.draft.orgId === filter.orgId
					)
				)
					.slice(0, 200)
					.map(row => clone(row.draft)),
			upsert: async draft => {
				const createdAt = orders.get(draft.orderId)?.createdAt ?? now()
				orders.set(draft.orderId, { draft: clone(draft), createdAt })
				return clone(draft)
			},
			updateUnlessFrozen: async draft => {
				const existing = orders.get(draft.orderId)
				if (!existing || existing.draft.status === 'frozen') return undefined
				existing.draft = clone(draft)
				return clone(draft)
			},
		},

		users: {
			get: async id => clone(users.get(id)),
			findByEmail: async email => clone([...users.values()].find(user => user.email === email)),
			insert: async user => createUser(user),
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
				const created: MagicLink = {
					tokenHash: link.tokenHash,
					email: link.email,
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
					link => link.email === email && new Date(link.createdAt) > since
				).length,
			insertRefreshToken: async token => {
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
			prune: async () => {
				const cutoff = Date.now()
				const weekAgo = cutoff - 7 * 24 * 60 * 60 * 1000
				for (const [hash, link] of magicLinks) {
					if (Date.parse(link.expiresAt) < weekAgo) magicLinks.delete(hash)
				}
				for (const [hash, token] of refreshTokens) {
					const revokedAt = token.revokedAt ? Date.parse(token.revokedAt) : undefined
					if (
						Date.parse(token.expiresAt) < cutoff ||
						(revokedAt !== undefined && revokedAt < weekAgo)
					) {
						refreshTokens.delete(hash)
					}
				}
			},
		},
	}
}
