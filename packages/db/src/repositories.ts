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
	ResidentInstallation,
	ResidentUsageRecord,
	ResidentUsageReport,
	ResidentUsageSummary,
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
	/**
	 * Active jobs with a launched Fargate task, older than `olderThan` — the api's liveness
	 * sweep re-checks these against `ecs:DescribeTasks` and fails the ones whose task is gone
	 */
	listStuck: (olderThan: Date) => Promise<Job[]>
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
	/**
	 * Sets the approve-before-deliver gate flag (W7); `undefined` when the order is missing.
	 * Idempotent — writing the same value returns the row unchanged.
	 */
	setApproveBeforeDeliver: (orderId: string, enabled: boolean) => Promise<Order | undefined>

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

export type NewUser = {
	email: string
	name?: string
	role: User['role']
	orgId: string
	githubId?: string
	githubLogin?: string
}
/** The GitHub identity written when a user signs in with GitHub (M6) */
export type GithubIdentity = { githubId: string; githubLogin: string; name?: string }
export type NewOrg = { name: string }

export type UsersRepository = {
	get: (id: string) => Promise<User | undefined>
	/** Exact match on the stored (lower-cased) email */
	findByEmail: (email: string) => Promise<User | undefined>
	findByGithubId: (githubId: string) => Promise<User | undefined>
	insert: (user: NewUser) => Promise<User>
	/**
	 * Stores the GitHub identity on the user (account linking / login rename). `name` is only
	 * written when the user has none. `undefined` for an unknown id; rejects with
	 * `code: '23505'` when the GitHub id is already linked to another user.
	 */
	linkGithub: (id: string, identity: GithubIdentity) => Promise<User | undefined>
	/**
	 * Creates the org and its first user atomically (first sign-in). Rejects with
	 * `code: '23505'` when the email already exists — without leaving an orphan org.
	 */
	insertWithOrg: (user: Omit<NewUser, 'orgId'>, org: NewOrg) => Promise<User>
	getOrg: (id: string) => Promise<Org | undefined>
	insertOrg: (org: NewOrg) => Promise<Org>
	listOrgs: () => Promise<Org[]>
}

/** `email`: an emailed magic link; `login`: the one-shot link a provider sign-in ends in (M6) */
export type MagicLinkPurpose = 'email' | 'login'

export type MagicLink = {
	tokenHash: string
	email: string
	purpose: MagicLinkPurpose
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
	/** `purpose` defaults to `email` */
	insertMagicLink: (link: {
		tokenHash: string
		email: string
		expiresAt: Date
		purpose?: MagicLinkPurpose
	}) => Promise<MagicLink>
	getMagicLink: (tokenHash: string) => Promise<MagicLink | undefined>
	/** Marks the link used; `undefined` when unknown or already used (single use, atomic) */
	consumeMagicLink: (tokenHash: string) => Promise<MagicLink | undefined>
	/** Emailed links (`purpose = 'email'`) created for the email since the given instant (rate limiting) */
	countMagicLinksSince: (email: string, since: Date) => Promise<number>
	insertRefreshToken: (token: {
		tokenHash: string
		userId: string
		expiresAt: Date
	}) => Promise<RefreshToken>
	/** Revokes the token and returns it; `undefined` when unknown or already revoked */
	consumeRefreshToken: (tokenHash: string) => Promise<RefreshToken | undefined>
	revokeRefreshToken: (tokenHash: string) => Promise<void>
	/**
	 * Housekeeping: drops expired links and revoked/expired tokens older than a week. Resolves to
	 * the number of rows deleted (0 on the memory backend, which sweeps itself on insert).
	 */
	pruneExpired: () => Promise<number>
}

// MARK: Resident (M8)

export type ResidentUsageFilter = { installationId?: string; month?: string }

/** `undefined` keeps the stored value, `null` clears it */
export type ResidentInstallationUpsert = {
	id: string
	orgId?: string | null
	billingCustomerId?: string | null
}

export type NewResidentUsageReport = Pick<
	ResidentUsageReport,
	'installationId' | 'month' | 'usdCents' | 'provider' | 'reference'
>

/** Compare-and-set on the month's report row, see `ResidentRepository.reserveUsageReport` */
export type ResidentUsageReportReservation = {
	installationId: string
	month: string
	provider: ResidentUsageReport['provider']
	/** The cumulative cents the caller read for this provider (0 when none / other provider) */
	fromUsdCents: number
	/** The cumulative cents after the report the caller is about to send */
	toUsdCents: number
	/** Provider identifier of that report (its idempotency key) */
	identifier: string
}

export type ResidentRepository = {
	getInstallation: (id: string) => Promise<ResidentInstallation | undefined>
	/** Newest first */
	listInstallations: () => Promise<ResidentInstallation[]>
	upsertInstallation: (upsert: ResidentInstallationUpsert) => Promise<ResidentInstallation>
	/**
	 * Stores the day's record (one per installation and day, last write wins) and creates the
	 * installation row on first contact
	 */
	upsertUsage: (record: ResidentUsageRecord) => Promise<ResidentUsageRecord>
	/** Newest day first */
	listUsage: (filter?: ResidentUsageFilter) => Promise<ResidentUsageRecord[]>
	/** One summary per installation and month, newest month first (without `report`) */
	summarizeUsage: (filter?: ResidentUsageFilter) => Promise<ResidentUsageSummary[]>
	getUsageReport: (
		installationId: string,
		month: string
	) => Promise<ResidentUsageReport | undefined>
	listUsageReports: (month?: string) => Promise<ResidentUsageReport[]>
	/** Sets the cumulative cents reported for the month (insert or replace) */
	upsertUsageReport: (report: NewResidentUsageReport) => Promise<ResidentUsageReport>
	/**
	 * Reserves the month's report before the provider is called: succeeds only when the row's
	 * cumulative cents still equal `fromUsdCents` and no other report is pending (a pending
	 * one with the same `identifier` is a retry and passes). A row of another provider is
	 * taken over with its cumulative reset to 0 — its reports never reached this provider.
	 * `undefined` = lost the race / stale read; nothing is written
	 */
	reserveUsageReport: (
		reservation: ResidentUsageReportReservation
	) => Promise<ResidentUsageReport | undefined>
	/**
	 * Confirms the pending report with the given identifier: the cumulative becomes the
	 * pending cents, the reference is stored, the reservation is cleared. `undefined` when
	 * no such reservation is pending
	 */
	confirmUsageReport: (
		installationId: string,
		month: string,
		identifier: string,
		reference: string | undefined
	) => Promise<ResidentUsageReport | undefined>
	/**
	 * Marks the pending report with the given identifier as no longer in flight (the provider
	 * rejected it): it stays pending — the next run retries it at once instead of waiting
	 * for the in-flight timeout
	 */
	releaseUsageReport: (installationId: string, month: string, identifier: string) => Promise<void>
}

/**
 * Sliding-window counters shared by every api task: one hit per row, scoped by feature
 * (`contact`) and keyed by the client (ip). Counting without a key gives the global total for
 * the scope. The memory implementation caps the number of keys it tracks and sweeps old hits
 * on every call; Postgres relies on the hourly `pruneExpired`.
 */
export type RateLimitsRepository = {
	/** Hits for `scope` (and `key` when given) strictly after `since` */
	count: (scope: string, key: string | undefined, since: Date) => Promise<number>
	record: (scope: string, key: string, at?: Date) => Promise<void>
	/**
	 * Housekeeping: drops hits older than the retention (longer than any counted window), which no
	 * longer affect any verdict. Resolves to the number of rows deleted (0 on the memory backend).
	 */
	pruneExpired: () => Promise<number>
}

export type Repositories = {
	jobs: JobsRepository
	orders: OrdersRepository
	users: UsersRepository
	auth: AuthRepository
	resident: ResidentRepository
	rateLimits: RateLimitsRepository
}
