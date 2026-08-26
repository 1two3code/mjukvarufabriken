/**
 * Repository interfaces shared by the Postgres implementation (`createPostgresRepositories`)
 * and the in-memory one (`createMemoryRepositories`, used by the api without a database and
 * by its tests). Services depend on these types only.
 */
import type {
	Job,
	JobEvent,
	NewJobEvent,
	Order,
	OrderStatus,
	Org,
	Payment,
	SpecDraft,
	User,
} from '@mf/models'
import type { JobUpdate, NewJob } from './jobs.ts'

export type JobsRepository = {
	insert: (job: NewJob) => Promise<Job>
	get: (id: string) => Promise<Job | undefined>
	/** The job whose report token hashes to `tokenHash` (build-container auth); never by id */
	getByReportToken: (tokenHash: string) => Promise<Job | undefined>
	list: (filter?: { orderId?: string; orgId?: string }) => Promise<Job[]>
	/** Returns `undefined` for an unknown id — or when a status write hits a killed job */
	update: (id: string, update: JobUpdate) => Promise<Job | undefined>
	appendEvent: (jobId: string, event: NewJobEvent) => Promise<JobEvent>
	/**
	 * Stores the build container's event number `seq` once: a replay of an already stored
	 * `(jobId, seq)` returns the original row with `duplicate: true` and writes nothing
	 */
	appendEventOnce: (
		jobId: string,
		seq: number,
		event: NewJobEvent
	) => Promise<{ event: JobEvent; duplicate: boolean }>
	countEvents: (jobId: string, type: JobEvent['type']) => Promise<number>
	listEvents: (jobId: string, afterId?: number) => Promise<JobEvent[]>
}

export type NewOrder = { id: string; orgId: string; name: string; createdBy?: string }

export type NewPayment = Pick<
	Payment,
	'orderId' | 'kind' | 'provider' | 'amountSek' | 'vatSek' | 'totalSek' | 'sessionId'
>

export type PaymentPaid = Pick<Payment, 'eventId' | 'hostedInvoiceUrl' | 'receiptUrl'>

/**
 * An order row carries both the `SpecDraft` keyed by `orderId` (M2) and the order record with
 * its state machine (M6). The draft's `status` is derived from the order status: `drafting` /
 * `ready` as-is, anything later reads as `frozen`.
 */
export type OrdersRepository = {
	get: (orderId: string) => Promise<SpecDraft | undefined>
	list: (filter?: { orgId?: string }) => Promise<SpecDraft[]>
	/**
	 * Inserts or replaces the whole draft; `createdBy` is only written on insert and the order
	 * status only while the order is still in its spec phase (drafting / ready / frozen)
	 */
	upsert: (draft: SpecDraft, createdBy?: string) => Promise<SpecDraft>
	/**
	 * Replaces the draft only while the stored row is not frozen (guards the read → engine →
	 * write window against a concurrent freeze); `undefined` when frozen or missing
	 */
	updateUnlessFrozen: (draft: SpecDraft) => Promise<SpecDraft | undefined>

	// MARK: Order record (M6)
	/** Creates a `drafting` order with an api-minted id */
	insert: (order: NewOrder) => Promise<Order>
	getOrder: (orderId: string) => Promise<Order | undefined>
	listOrders: (filter?: { orgId?: string }) => Promise<Order[]>
	/** Atomic compare-and-set on the status; `undefined` when missing or not in `from` */
	transition: (
		orderId: string,
		from: readonly OrderStatus[],
		to: OrderStatus
	) => Promise<Order | undefined>

	// MARK: Payments (M6)
	insertPayment: (payment: NewPayment) => Promise<Payment>
	getPayment: (id: string) => Promise<Payment | undefined>
	findPaymentBySession: (sessionId: string) => Promise<Payment | undefined>
	/** Oldest first */
	listPayments: (orderId: string) => Promise<Payment[]>
	/** Marks a pending payment paid; `undefined` when unknown or already paid */
	markPaymentPaid: (id: string, paid: PaymentPaid) => Promise<Payment | undefined>
	/** Records a processed webhook event id; false when it was seen before (idempotency) */
	recordPaymentEvent: (eventId: string, type: string) => Promise<boolean>
	/** Drops a recorded event id so a redelivery is processed again (the apply step failed) */
	forgetPaymentEvent: (eventId: string) => Promise<void>
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

/**
 * Sliding-window counters shared by every api task: one hit per row, scoped by feature
 * (`contact`) and keyed by the client (ip). Counting without a key gives the global total for
 * the scope. The memory implementation caps the number of keys it tracks and sweeps old hits
 * on every call; Postgres relies on the hourly `prune`.
 */
export type RateLimitsRepository = {
	/** Hits for `scope` (and `key` when given) strictly after `since` */
	count: (scope: string, key: string | undefined, since: Date) => Promise<number>
	record: (scope: string, key: string, at?: Date) => Promise<void>
	/** Housekeeping: drops hits older than `before` */
	prune: (before: Date) => Promise<void>
}

export type Repositories = {
	jobs: JobsRepository
	orders: OrdersRepository
	users: UsersRepository
	auth: AuthRepository
	rateLimits: RateLimitsRepository
}
