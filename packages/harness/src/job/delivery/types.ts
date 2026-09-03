import type {
	AcceptanceReport,
	Deliverable,
	DeliveryEventPayload,
	DeployedServiceReport,
	GateReport,
	NewJobEvent,
	Plan,
	Spec,
} from '@mf/models'
import type { TokenUsage } from '#job/types.ts'
import type { LiveCheck } from './liveAcceptance.ts'

// MARK: Target

/** Who the build is delivered to — derived from the order by apps/job */
export type DeliveryTarget = {
	/** Repository name under the GitHub org: `mjukvaruhuset/<slug>` */
	slug: string
	/** Human-readable application name for README / HANDOVER */
	appName: string
	/** GitHub login of the customer; without it the repo is left `transferPending` */
	customerGithubLogin?: string
}

// MARK: Clients (one small interface per external system; fakes + dry-run in tests/demo)

export type CreatedRepo = {
	/** `https://github.com/<org>/<name>` */
	url: string
	/** HTTPS clone URL the job pushes to (the token is added at push time, never stored) */
	cloneUrl: string
}

export type GitHubClient = {
	/**
	 * Creates a private repository in the org. A repository of that name that already exists is
	 * REUSED (its urls returned), not an error: a redelivery pushes the same repository again.
	 */
	createRepo: (input: { org: string; name: string; description: string }) => Promise<CreatedRepo>
	/** Pushes `branch` of `repoDir` to the created repo */
	push: (input: { repoDir: string; cloneUrl: string; branch: string }) => Promise<void>
	/** Clones an org repository into `dir` (a redelivery's starting point) */
	clone: (input: { cloneUrl: string; dir: string }) => Promise<void>
	addCollaborator: (input: {
		org: string
		name: string
		login: string
		permission: 'admin'
	}) => Promise<void>
}

export type DeployClient = {
	/**
	 * Builds the customer image and creates an ECS Express Mode service from it, deployed from the
	 * pushed repo; resolves to the managed HTTPS URL. One service per job (`mf-<job8>-<slug>`), so
	 * a redelivery never collides with another job's preview. Rejects when `signal` aborts (kill
	 * switch / budget) instead of polling on.
	 */
	deployFromRepo: (input: {
		serviceName: string
		repositoryUrl: string
		branch: string
		/** S3 location of this job's repo zip — CodeBuild builds the image from it (per-job source) */
		source: { bucket: string; key: string }
		/**
		 * The built app's full required runtime env (from the env manifest: generated app secrets,
		 * auth contract, self-issued secrets, flagged placeholders) to set on the live container, so
		 * an app requiring its own secrets runs live instead of crashlooping. Omitted → the client
		 * falls back to the fixed generated app-secret set (older callers / static deliveries).
		 */
		env?: Record<string, string>
		/**
		 * IAM role the delivered task runs AS (not the execution role, which only pulls the image).
		 * Set when the app was provisioned object storage: the role is scoped to that app's prefix
		 * alone, so the container reads its credentials from the task metadata endpoint and IAM —
		 * not convention — stops it reaching another delivered app's objects.
		 */
		taskRoleArn?: string
		signal?: AbortSignal
	}) => Promise<{
		url: string
		/**
		 * The service that was stood up — its name/arn/image and the create config `resume` replays
		 * — so the api can record it per order (teardown targets EVERY recorded service, resume
		 * re-creates a suspended one). Omitted by the dry-run client (nothing was actually created).
		 */
		service?: DeployedServiceReport
	}>
}

/**
 * Identity provider the preview api verifies tokens against (`AUTH_ISSUER` / `AUTH_JWKS_URL` /
 * `AUTH_AUDIENCE`, passed as the Express container's environment). The template api refuses to
 * boot without them, so without this the deploy step is not attempted.
 */
export type PreviewAuth = {
	issuer: string
	jwksUrl: string
	audience: string
}

/**
 * Smoke-boots the built artifact before a service is stood up: in-process green (lint + vitest)
 * does not prove the real `node src/index.ts` boots — an env-contract mismatch or a named ESM
 * import of a CJS-only dep crashes only at a real boot. `ok: false` → the deploy is skipped and
 * the reason surfaced, instead of standing up a service that 503s.
 */
export type BootCheck = {
	boot: (input: {
		repoDir: string
		/** Runtime env the app needs to boot (auth contract + any generated secrets) */
		env: Record<string, string>
		signal?: AbortSignal
	}) => Promise<{ ok: boolean; output: string; reason?: string }>
}

/**
 * Provisions the delivered app's own database (a dedicated database + login role on the
 * platform's Postgres, docs/DELIVERED-DB.md). Implemented by the api's
 * `/internal/jobs/:jobId/database` endpoint, called with the job's report token — the build
 * container NEVER holds the admin database credentials, it only receives the scoped URL back.
 * Absent (local db-mode runs, older callers) → an app that needs a database fails closed: the
 * deploy is skipped with a clear reason instead of shipping a live-but-dead URL.
 */
export type DbProvisioner = {
	provision: (input?: { signal?: AbortSignal }) => Promise<{ databaseUrl: string }>
}

/**
 * Provisions the delivered app's object storage through the api (docs/PREVIEW-RESOURCES.md): a
 * prefix in the shared preview bucket plus an IAM role scoped to exactly that prefix, which the
 * deploy then passes as the delivered task's role. Same credential shape as {@link DbProvisioner}
 * — the build container holds nothing, it only receives the names back. Absent (local db-mode
 * runs, older callers) → an app that needs storage fails closed rather than shipping one whose
 * uploads 500 or, worse, land on container-local disk and vanish on the next deployment.
 */
export type StorageProvisioner = {
	provision: (input?: { signal?: AbortSignal }) => Promise<{
		bucket: string
		prefix: string
		region: string
		roleArn: string
	}>
}

export type ArtifactStore = {
	/** Which backend backs the store — real S3, dry-run logger, in-memory fake, or unconfigured */
	kind: 's3' | 'dry-run' | 'fake' | 'none'
	bucket: string
	/** Public HTTPS URL of an object (virtual-hosted style) */
	urlOf: (key: string) => string
	putObject: (input: {
		key: string
		body: Uint8Array | string
		contentType: string
	}) => Promise<void>
}

/** Writes the prose sections of HANDOVER.md (one Agent SDK session live; a fake in tests) */
export type ProseWriter = (input: {
	spec: Spec
	plan?: Plan
	repoDir: string
	signal: AbortSignal
	onUsage: (usage: TokenUsage) => void
}) => Promise<{ summary: string; tokens: number }>

export type DeliveryClients = {
	github: GitHubClient
	deploy: DeployClient
	artifacts: ArtifactStore
	prose?: ProseWriter
	/**
	 * Boots the built artifact before the deploy (acceptance smoke). Omitted → the boot check is
	 * skipped (gates-only runs, older callers); provided → a boot failure skips the deploy.
	 */
	boot?: BootCheck
	/**
	 * Post-deploy end-to-end acceptance check (liveAcceptance.ts): probes the LIVE preview URL
	 * like a customer. Omitted → the step is skipped (older callers); a failure withholds the
	 * URL from the deliverable and pages the admins.
	 */
	liveCheck?: LiveCheck
	/** Provisions the delivered app's database when it needs one (docs/DELIVERED-DB.md) */
	dbProvisioner?: DbProvisioner
	/** Provisions the delivered app's object storage when it needs it (docs/PREVIEW-RESOURCES.md) */
	storageProvisioner?: StorageProvisioner
	/** GitHub organisation that owns customer repos (default `mjukvaruhuset`) */
	githubOrg?: string
	/** IdP for the preview api; without it the Express deploy step is not attempted */
	previewAuth?: PreviewAuth
	/**
	 * The job's own live secret values (Anthropic key, GitHub App private key, report token, …) —
	 * the delivery secret scan (hardening A2) fails closed when any of them appears in the
	 * delivered tree or history. Values only; never logged, never delivered.
	 */
	knownSecrets?: string[]
	/** Log instead of calling GitHub / ECS Express / S3 (`--dry-run`); events say so */
	dryRun?: boolean
}

// MARK: Input / outcome

export type DeliveryInput = {
	jobId: string
	/**
	 * The job the preview service is named after — the SOURCE job on a redelivery, so the same
	 * Express service is updated rather than a second one created. Defaults to `jobId`.
	 */
	serviceJobId?: string
	spec: Spec
	plan?: Plan
	gates: GateReport[]
	repoDir: string
	target: DeliveryTarget
	signal: AbortSignal
	onUsage: (usage: TokenUsage) => void
	/** Awaited per step; a rejection is swallowed (the event sink is not fatal) */
	emit: (event: NewJobEvent) => Promise<void>
	now?: () => number
}

export type DeliveryOutcome = {
	/** Repo pushed + bundle uploaded (the contract); a failed deploy does not make this false */
	ok: boolean
	tokens: number
	deliverable?: Deliverable
	/**
	 * Why `ok` is false, or what the deploy step flagged: why `deployUrl` is null — or, with a
	 * live URL, its operator notes (env-manifest placeholders, a blocked site upload). Callers
	 * that put a reason on the JOB must gate on `deliverable.deployUrl` (the orchestrator does).
	 */
	reason?: string
	/** One payload per step that ran, in order */
	steps: DeliveryEventPayload[]
}

/** The acceptance report of the acceptance-check gate, when it ran */
export const acceptanceReportOf = (gates: GateReport[]): AcceptanceReport | undefined =>
	gates.find(gate => gate.name === 'acceptance-check')?.details?.report as
		AcceptanceReport | undefined
