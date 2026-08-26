/**
 * Repository interfaces shared by the Postgres implementation (`createPostgresRepositories`)
 * and the in-memory one (`createMemoryRepositories`, used by the api without a database and
 * by its tests). Services depend on these types only.
 */
import type { Job, JobEvent, NewJobEvent, Org, SpecDraft, User } from '@mf/models'
import type { JobUpdate, NewJob } from './jobs.ts'

export type JobsRepository = {
	insert: (job: NewJob) => Promise<Job>
	get: (id: string) => Promise<Job | undefined>
	list: (filter?: { orderId?: string; orgId?: string }) => Promise<Job[]>
	/** Returns `undefined` for an unknown id — or when a status write hits a killed job */
	update: (id: string, update: JobUpdate) => Promise<Job | undefined>
	appendEvent: (jobId: string, event: NewJobEvent) => Promise<JobEvent>
	listEvents: (jobId: string, afterId?: number) => Promise<JobEvent[]>
}

/** An order row is the `SpecDraft` keyed by `orderId` (M2); M6 adds the payment columns */
export type OrdersRepository = {
	get: (orderId: string) => Promise<SpecDraft | undefined>
	list: (filter?: { orgId?: string }) => Promise<SpecDraft[]>
	/** Inserts or replaces the whole draft; `createdBy` is only written on insert */
	upsert: (draft: SpecDraft, createdBy?: string) => Promise<SpecDraft>
	/**
	 * Replaces the draft only while the stored row is not frozen (guards the read → engine →
	 * write window against a concurrent freeze); `undefined` when frozen or missing
	 */
	updateUnlessFrozen: (draft: SpecDraft) => Promise<SpecDraft | undefined>
}

export type NewUser = { email: string; name?: string; role: User['role']; orgId: string }
export type NewOrg = { name: string }

export type UsersRepository = {
	get: (id: string) => Promise<User | undefined>
	/** Exact match on the stored (lower-cased) email */
	findByEmail: (email: string) => Promise<User | undefined>
	insert: (user: NewUser) => Promise<User>
	/**
	 * Creates the org and its first user atomically (first sign-in). Rejects with
	 * `code: '23505'` when the email already exists — without leaving an orphan org.
	 */
	insertWithOrg: (user: Omit<NewUser, 'orgId'>, org: NewOrg) => Promise<User>
	getOrg: (id: string) => Promise<Org | undefined>
	insertOrg: (org: NewOrg) => Promise<Org>
	listOrgs: () => Promise<Org[]>
}

export type MagicLink = {
	tokenHash: string
	email: string
	createdAt: string
	expiresAt: string
	usedAt?: string
}

export type RefreshToken = {
	tokenHash: string
	userId: string
	createdAt: string
	expiresAt: string
	revokedAt?: string
}

export type AuthRepository = {
	insertMagicLink: (link: {
		tokenHash: string
		email: string
		expiresAt: Date
	}) => Promise<MagicLink>
	getMagicLink: (tokenHash: string) => Promise<MagicLink | undefined>
	/** Marks the link used; `undefined` when unknown or already used (single use, atomic) */
	consumeMagicLink: (tokenHash: string) => Promise<MagicLink | undefined>
	/** Links created for the email since the given instant (rate limiting) */
	countMagicLinksSince: (email: string, since: Date) => Promise<number>
	insertRefreshToken: (token: {
		tokenHash: string
		userId: string
		expiresAt: Date
	}) => Promise<RefreshToken>
	/** Revokes the token and returns it; `undefined` when unknown or already revoked */
	consumeRefreshToken: (tokenHash: string) => Promise<RefreshToken | undefined>
	revokeRefreshToken: (tokenHash: string) => Promise<void>
	/** Housekeeping: drops expired links and revoked/expired tokens older than a week */
	prune: () => Promise<void>
}

export type Repositories = {
	jobs: JobsRepository
	orders: OrdersRepository
	users: UsersRepository
	auth: AuthRepository
}
