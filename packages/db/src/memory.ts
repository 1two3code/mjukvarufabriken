/**
 * In-memory implementation of the repositories — the api uses it when no database is
 * configured (local dev without docker) and in its tests, so the SQL layer and the services
 * share one contract. Behaviour mirrors the Postgres rules that services rely on: killed jobs
 * are terminal, one active job per order (rejects with `code: '23505'`), single-use magic
 * links and refresh tokens. Everything is lost when the process exits.
 */
import { isActiveJobStatus } from '@mf/models'

import type { Job, JobEvent, Org, SpecDraft, User } from '@mf/models'
import type { MagicLink, RefreshToken, Repositories } from './repositories.ts'

const clone = <T>(value: T): T => structuredClone(value)
const now = () => new Date().toISOString()

/** Mimics the driver's unique-violation error for `jobs_one_active_per_order` */
export class UniqueViolation extends Error {
	code = '23505'
	constructor(constraint: string) {
		super(`duplicate key value violates unique constraint "${constraint}"`)
	}
}

export const createMemoryRepositories = (): Repositories => {
	const jobs = new Map<string, Job>()
	const events: JobEvent[] = []
	const orders = new Map<string, SpecDraft>()
	const users = new Map<string, User>()
	const orgs = new Map<string, Org>()
	const magicLinks = new Map<string, MagicLink>()
	const refreshTokens = new Map<string, RefreshToken>()

	const byCreatedDesc = <T extends { createdAt: string }>(items: T[]) =>
		items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

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
				return clone(created)
			},
			get: async id => clone(jobs.get(id)),
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
				const next: Job = {
					...job,
					status: update.status ?? job.status,
					tokensUsed: update.tokensUsed ?? job.tokensUsed,
					plan: update.plan ?? job.plan,
					reason: update.reason ?? job.reason,
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
			listEvents: async (jobId, afterId = 0) =>
				events
					.filter(event => event.jobId === jobId && event.id > afterId)
					.slice(0, 500)
					.map(clone),
		},

		orders: {
			get: async orderId => clone(orders.get(orderId)),
			list: async (filter = {}) =>
				[...orders.values()]
					.filter(draft => filter.orgId === undefined || draft.orgId === filter.orgId)
					.map(clone),
			upsert: async draft => {
				orders.set(draft.orderId, clone(draft))
				return clone(draft)
			},
		},

		users: {
			get: async id => clone(users.get(id)),
			findByEmail: async email => clone([...users.values()].find(user => user.email === email)),
			insert: async user => {
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
			},
			getOrg: async id => clone(orgs.get(id)),
			insertOrg: async org => {
				const created: Org = { id: crypto.randomUUID(), name: org.name, createdAt: now() }
				orgs.set(created.id, created)
				return clone(created)
			},
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
		},
	}
}
