/**
 * Repository interfaces shared by the Postgres implementation (`createPostgresRepositories`)
 * and the in-memory one (`createMemoryRepositories`, used by the api without a database and
 * by its tests). Services depend on these types only.
 */
import type {
	IterationBrief,
	IterationBriefEntry,
	DeployedService,
	DeployedServiceConfig,
	Job,
	JobEvent,
	ModelPriceRow,
	ModelPrices,
	NewModelPrice,
	LifecycleState,
	NewJobEvent,
	Order,
	OrderStatus,
	Org,
	Payment,
	NewPricingTier,
	PricingTierRow,
	ResidentInstallation,
	ResidentUsageRecord,
	ResidentUsageReport,
	ResidentUsageSummary,
	SpecDraft,
	User,
} from '@mf/models'
import type { JobUpdate, NewJob, RetryOf } from './jobs.ts'

export type JobsRepository = {
	insert: (job: NewJob) => Promise<Job>
	/**
	 * Inserts the ONE automatic rebuild of a failed job atomically with the `retry` events that
	 * link — and disqualify — both rows (the once-only bound of the demo auto-retry is
	 * structural: no crash can leave a retry row that looks like a fresh first attempt).
	 * Rejects with the same 23505 as `insert` when another job is active for the order.
	 */
	insertRetry: (job: NewJob, ofJob: RetryOf) => Promise<Job>
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

	// MARK: Lifecycle (wave 9, deprovisioning)
	/**
	 * Compare-and-set on the deprovisioning lifecycle (`active` | `suspended` | `torn_down`),
	 * stamping the change time. `from` guards the transition; `undefined` when the row is missing
	 * or its lifecycle is not in `from`. Writing the state it already holds is an idempotent no-op
	 * that still returns the row (the current state is in `from`).
	 */
	setLifecycle: (
		orderId: string,
		from: readonly LifecycleState[],
		to: LifecycleState
	) => Promise<Order | undefined>
	/** Stores the per-customer fence slug (set when the build starts); `undefined` when missing */
	setCustomerSlug: (orderId: string, customerSlug: string) => Promise<Order | undefined>
	/** Suspended orders whose lifecycle changed before the instant — the grace-period sweep's candidates */
	listSuspendedBefore: (changedBefore: Date) => Promise<Order[]>

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

	// MARK: Margin (M12)
	/**
	 * Distinct orgs with a non-cancelled order still in the `active` deprovisioning lifecycle —
	 * the phase-1 infra cost allocation's divisor (M12 margin calculator, PLAN.md)
	 */
	listActiveOrgIds: () => Promise<string[]>
	/**
	 * Per-org sum of paid payments (`deposit` + `balance`), ex moms — the "build fee" revenue
	 * line of the M12 margin calculator
	 */
	sumPaidPaymentsByOrg: () => Promise<{ orgId: string; amountSek: number }[]>
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
	/**
	 * Records the vended per-customer AWS account id + slug on the org (onboarding's
	 * `provisionCustomerAccount` step, org-accounts.md #4). `undefined` when the org is missing.
	 */
	linkAwsAccount: (
		orgId: string,
		account: { accountId: string; slug: string }
	) => Promise<Org | undefined>
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

// MARK: Iteration brief (wave 10)

/** The api mints the entry `id` + `createdAt`; the repository stores the full entry */
export type IterationBriefRepository = {
	/** The brief for one org and project; `undefined` when the project has none yet */
	get: (orgId: string, projectId: string) => Promise<IterationBrief | undefined>
	/** The org's briefs (or every org's when omitted), most recently updated first */
	list: (orgId?: string) => Promise<IterationBrief[]>
	/**
	 * Appends the entry to the (org, project) brief, creating it on first contact. `title` is
	 * written only when the brief is created.
	 */
	appendEntry: (
		orgId: string,
		projectId: string,
		entry: IterationBriefEntry,
		title?: string
	) => Promise<IterationBrief>
}

// MARK: Deployed services (wave 10, delivery-lifecycle-followups)

/** A service delivery reports it stood up, to be recorded against the order. */
export type NewDeployedService = {
	orderId: string
	jobId?: string
	serviceName: string
	serviceArn?: string | null
	customerTag: string
	image?: string | null
	config?: DeployedServiceConfig | null
}

/**
 * Every ECS Express service a delivery stood up, tracked per order so a teardown finds ALL of a
 * rebuilt order's live services (not just the newest fence) and `resume` can replay the recorded
 * image/config to re-create a suspended (deleted) service. See migration 0016.
 */
export type DeployedServicesRepository = {
	/**
	 * Records the service for the order. Idempotent on `(orderId, serviceName)` among live rows:
	 * a redelivery of the same service updates its arn/image/config in place rather than
	 * duplicating, and re-records a previously torn-down name as a fresh live row.
	 */
	record: (service: NewDeployedService) => Promise<DeployedService>
	/** The order's live (not torn-down) services, oldest first. */
	listForOrder: (orderId: string) => Promise<DeployedService[]>
	/** Updates a service's arn (its new one after a resume re-create, or null after a suspend). */
	setArn: (id: string, serviceArn: string | null) => Promise<DeployedService | undefined>
	/**
	 * A suspend deletes the Express service — null every live row's arn for the order to reflect
	 * that its compute is gone (the record + config stay for resume). Returns the rows updated.
	 */
	markSuspended: (orderId: string) => Promise<number>
	/** A teardown permanently removes the services — soft-delete every live row. Returns the count. */
	markTornDown: (orderId: string) => Promise<number>
}

// MARK: Model prices (per-job cost)

/**
 * The operator-editable Anthropic price table (migration 0018). Append-only: a new row for a
 * prefix takes effect for orders created from its `effectiveFrom` on; earlier orders keep the
 * prices they were created under.
 */
export type ModelPricesRepository = {
	/** Every row, newest `effectiveFrom` first */
	list: () => Promise<ModelPriceRow[]>
	/** Adds a row (`effectiveFrom` defaults to now); rejects with `code: '23505'` on an exact duplicate */
	insert: (price: NewModelPrice) => Promise<ModelPriceRow>
	/** The prices in effect at the instant, keyed by prefix (`pricesEffectiveAt`) */
	effectiveAt: (at: Date) => Promise<ModelPrices>
}

// MARK: Pricing tiers (customer-facing offer)

/**
 * The operator-editable pricing-tier table (migration 0019, seeded with the decided ladder in
 * 0020). Append-only, same shape as `ModelPricesRepository`: a new row for a `tierKey` takes
 * effect from its `effectiveFrom` on. The spec engine's price estimate reads the `build_s/m/l`
 * rows at freeze time (`sizePricesFromTiers` in @mf/harness); the other rows are the admin's
 * price list for tiers whose flows are not built yet.
 */
export type PricingTiersRepository = {
	/** Every row, newest `effectiveFrom` first — the admin's full history */
	list: () => Promise<PricingTierRow[]>
	/** Adds a row (`effectiveFrom` defaults to now); rejects with `code: '23505'` on an exact duplicate */
	insert: (tier: NewPricingTier) => Promise<PricingTierRow>
}

export type Repositories = {
	jobs: JobsRepository
	modelPrices: ModelPricesRepository
	pricingTiers: PricingTiersRepository
	orders: OrdersRepository
	deployedServices: DeployedServicesRepository
	users: UsersRepository
	auth: AuthRepository
	resident: ResidentRepository
	rateLimits: RateLimitsRepository
	iterationBrief: IterationBriefRepository
}
