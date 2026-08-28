import type {
	AcceptanceReport,
	Deliverable,
	DeliveryEventPayload,
	GateReport,
	NewJobEvent,
	Plan,
	Spec,
} from '@mf/models'
import type { TokenUsage } from '#job/types.ts'

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
	/** Creates a private repository in the org; an existing repo of that name is an error */
	createRepo: (input: { org: string; name: string; description: string }) => Promise<CreatedRepo>
	/** Pushes `branch` of `repoDir` to the created repo */
	push: (input: { repoDir: string; cloneUrl: string; branch: string }) => Promise<void>
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
		signal?: AbortSignal
	}) => Promise<{ url: string }>
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
	/** GitHub organisation that owns customer repos (default `mjukvaruhuset`) */
	githubOrg?: string
	/** IdP for the preview api; without it the Express deploy step is not attempted */
	previewAuth?: PreviewAuth
	/** Log instead of calling GitHub / ECS Express / S3 (`--dry-run`); events say so */
	dryRun?: boolean
}

// MARK: Input / outcome

export type DeliveryInput = {
	jobId: string
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
	/** Why `ok` is false, or why `deployUrl` is null */
	reason?: string
	/** One payload per step that ran, in order */
	steps: DeliveryEventPayload[]
}

/** The acceptance report of the acceptance-check gate, when it ran */
export const acceptanceReportOf = (gates: GateReport[]): AcceptanceReport | undefined =>
	gates.find(gate => gate.name === 'acceptance-check')?.details?.report as
		AcceptanceReport | undefined
