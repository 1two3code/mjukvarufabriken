import { deliverableKeyOf, uploadBundle, uploadSite, uploadSource } from './bundle.ts'
import { buildEnvManifest, detectDatabaseNeed, detectStorageNeed } from './envManifest.ts'
import { curateWorkflows, stripInternalGitArtifacts } from './curate.ts'
import { writeDocs } from './docs.ts'
import { defaultGitHubOrg } from './github.ts'
import { scanRepoForSecrets, secretScanReason } from './secretScan.ts'
import { acceptanceReportOf } from './types.ts'

import { git } from '#job/exec.ts'
import { totalTokens } from '#job/types.ts'

import type { Deliverable, DeliveryEventPayload, NotifyPayload } from '@mf/models'
import type { TokenUsage } from '#job/types.ts'
import type { LiveAcceptanceResult } from './liveAcceptance.ts'
import type { DeliveryClients, DeliveryInput, DeliveryOutcome } from './types.ts'

/** Throws on a failed add/commit: the pushed repo and repo.zip must carry the docs */
const commitDocs = async (repoDir: string, signal: AbortSignal) => {
	await git(['add', '-A'], { cwd: repoDir, signal })
	await git(['commit', '-q', '-m', 'docs: handover and test report'], {
		cwd: repoDir,
		signal,
	})
}

/**
 * ECS Express service name: the job-unique part first (`mf-<job8>-<slug>`), so no length limit
 * ever cuts off the discriminator (the slug already ends with the same job prefix — an app name
 * of 37+ chars used to leave two jobs with the same goal on one service)
 */
export const previewServiceName = (jobId: string, slug: string) =>
	`mf-${jobId.slice(0, 8)}-${slug}`

/** The `notify` payload for a delivered job whose preview deployment failed */
export const deployFailedNotification = (
	jobId: string,
	repositoryUrl: string,
	reason: string
): NotifyPayload => ({
	to: 'admins',
	subject: `Build job ${jobId} delivered without a preview URL`,
	text: `Job ${jobId} was delivered (repo ${repositoryUrl} + bundle uploaded) but the ECS Express deployment failed:\n\n${reason}\n\nDeploy it by hand or re-run the delivery.`,
})

/**
 * The `notify` payload when the service deployed but the post-deploy acceptance check found the
 * live app broken — the URL is withheld from the deliverable (never presented as working), the
 * service stays up for the admins to inspect and remains recorded for teardown.
 */
export const acceptanceFailedNotification = (
	jobId: string,
	deployUrl: string,
	reason: string
): NotifyPayload => ({
	to: 'admins',
	subject: `Build job ${jobId} deployed but FAILED the live acceptance check`,
	text: `Job ${jobId}'s preview deployed to ${deployUrl}, but probing it like a customer found it broken — the URL was withheld from the deliverable:\n\n${reason}\n\nThe service is still up for inspection (and recorded for teardown). Fix and re-deliver, or tear it down.`,
})

/** The informational log line for the "Built by Mjukvaruhuset" footer check (never a failure) */
export const builtByFooterLogLine = (present: boolean, deployUrl: string) =>
	present
		? `built-by footer: present in the rendered page at ${deployUrl}`
		: `built-by footer: MISSING from the rendered page at ${deployUrl} — the delivered app does not link to mjukvaruhuset.se (informational; the template's components/builtBy was dropped or VITE_BUILT_BY_URL emptied)`

/**
 * Delivery after green gates, in five steps that each emit a `delivery` event:
 *   docs       — HANDOVER.md / TEST-REPORT.md / README.md written + committed
 *   repo       — private GitHub repo `mjukvaruhuset/<slug>`, main pushed, customer added as admin
 *   deploy     — ECS Express service (built image → managed URL) + SPA build to the artifacts
 *                bucket; an app that needs a database gets one provisioned first (or no deploy)
 *   acceptance — the LIVE URL probed like a customer (liveAcceptance.ts); a failure withholds
 *                the URL from the deliverable and pages the admins
 *   bundle     — repo.zip, docs and the gate/acceptance reports under `deliverables/<jobId>/`
 * The repo push and the bundle are the contract (`ok`); a failed deploy leaves `deployUrl`
 * null and raises a `notify` event for the admins. A docs failure is fatal: without the commit
 * the repo and the archive would be wrong.
 */
export const deliver = async (
	{
		jobId,
		serviceJobId = jobId,
		spec,
		plan,
		gates,
		repoDir,
		target,
		signal,
		onUsage,
		emit,
		now = Date.now,
	}: DeliveryInput,
	clients: DeliveryClients
): Promise<DeliveryOutcome> => {
	const {
		github,
		deploy,
		artifacts,
		prose,
		boot,
		liveCheck,
		dbProvisioner,
		storageProvisioner,
		previewAuth,
		githubOrg = defaultGitHubOrg,
		dryRun,
	} = clients
	const steps: DeliveryEventPayload[] = []
	let tokens = 0
	const count = (usage: TokenUsage) => {
		tokens += totalTokens(usage)
		onUsage(usage)
	}
	const step = async (payload: Omit<DeliveryEventPayload, 'dryRun'>) => {
		const event: DeliveryEventPayload = dryRun ? { ...payload, dryRun } : payload
		steps.push(event)
		await emit({ type: 'delivery', payload: event }).catch(() => {})
	}
	const fail = (reason: string): DeliveryOutcome => ({ ok: false, tokens, reason, steps })
	const aborted = () => (signal.aborted ? fail('aborted') : undefined)

	// MARK: docs
	let summary = ''
	if (prose) {
		try {
			summary = (await prose({ spec, plan, repoDir, signal, onUsage: count })).summary
		} catch (error) {
			summary = ''
			await emit({
				type: 'log',
				payload: { message: `handover prose session failed: ${(error as Error).message}` },
			}).catch(() => {})
		}
	}
	if (aborted()) return aborted()!
	const repositoryUrl = `https://github.com/${githubOrg}/${target.slug}`
	const verify = gates.find(gate => gate.name === 'verify')
	let docs
	try {
		docs = await writeDocs(repoDir, {
			spec,
			plan,
			gates,
			target,
			jobId,
			summary,
			repositoryUrl,
			verifyOutput: verify?.summary,
		})
		// Strip OUR CI/deploy workflows (OIDC into our account) and ship a customer-appropriate
		// lint+test CI instead — committed with the docs so it lands in the push and in repo.zip.
		// Strip internal git-recovery leftovers (`.git-broken` / `.git.bak`) a build can strand in
		// the worktree, so the delivery `git add -A` never commits them into the customer repo.
		const strippedGitArtifacts = await stripInternalGitArtifacts(repoDir)
		if (strippedGitArtifacts.length) {
			await emit({
				type: 'log',
				payload: { message: `stripped internal git artifacts: ${strippedGitArtifacts.join(', ')}` },
			}).catch(() => {})
		}
		const curated = await curateWorkflows(repoDir)
		if (curated.removed.length) {
			await emit({
				type: 'log',
				payload: {
					message: `curated .github/workflows: removed ${curated.removed.join(', ')}; wrote ${curated.wrote}`,
				},
			}).catch(() => {})
		}
		await commitDocs(repoDir, signal)
		await step({ step: 'docs', ok: true })
	} catch (error) {
		return fail(`handover docs failed: ${(error as Error).message}`)
	}
	if (aborted()) return aborted()!

	// MARK: secret scan (hardening A2) — deterministic, injection-proof, fails the delivery
	// closed BEFORE anything leaves the building (repo push, bundle upload). Scans exactly what
	// is delivered: the committed tree + the git history (binaries and merge-commit blobs
	// included). Runs in dry-run too (it is local). The one delivered artifact git does not
	// cover — the untracked dist/ output `uploadSite` ships — gets its own scan inside
	// `uploadSite`, which blocks that upload the same way.
	try {
		const scan = await scanRepoForSecrets(repoDir, {
			knownSecrets: clients.knownSecrets,
			signal,
		})
		if (!scan.ok) {
			const reason = secretScanReason(scan)
			await step({ step: 'secret-scan', ok: false, reason })
			return fail(reason)
		}
		await step({ step: 'secret-scan', ok: true })
	} catch (error) {
		// Fail closed: a scan that cannot run is a scan that did not pass
		const reason = `secret scan could not run: ${(error as Error).message}`
		await step({ step: 'secret-scan', ok: false, reason })
		return fail(reason)
	}
	if (aborted()) return aborted()!

	// MARK: repo
	let transferPending = target.customerGithubLogin
		? undefined
		: 'transfer pending: no customer GitHub login'
	try {
		const repo = await github.createRepo({
			org: githubOrg,
			name: target.slug,
			description: `${target.appName} — built by Mjukvaruhuset (job ${jobId})`,
		})
		await github.push({ repoDir, cloneUrl: repo.cloneUrl, branch: 'main' })
		if (target.customerGithubLogin) {
			try {
				await github.addCollaborator({
					org: githubOrg,
					name: target.slug,
					login: target.customerGithubLogin,
					permission: 'admin',
				})
			} catch (error) {
				// The push is the contract; a failed invitation is an admin follow-up, not a failure
				transferPending = `transfer pending: adding ${target.customerGithubLogin} as admin failed: ${(error as Error).message}`
				await emit({ type: 'log', payload: { message: transferPending } }).catch(() => {})
			}
		}
		await step({
			step: 'repo',
			ok: true,
			url: repo.url,
			reason: transferPending,
		})
	} catch (error) {
		const reason = `github: ${(error as Error).message}`
		await step({ step: 'repo', ok: false, reason })
		return fail(reason)
	}
	if (aborted()) return aborted()!

	// MARK: deploy (best effort)
	let deployUrl: string | null = null
	let deployedService: Deliverable['deployedService']
	let deployReason: string | undefined
	// Detect the built app's OWN required runtime env and resolve a value for each (generated app
	// secrets + auth contract, a fresh self-issued secret, or a flagged placeholder). The SAME set
	// is injected into the boot smoke-check and the live container, so an app requiring arbitrary
	// secrets boots in the check AND runs live — not just the fixed template contract.
	const manifest = await buildEnvManifest(repoDir, previewAuth)
	if (manifest.todos.length) {
		// A required var we could not generate got a placeholder — surface it, never silently omit it.
		const note = `env manifest: ${manifest.placeholders.length} required var(s) need operator values before real use — ${manifest.placeholders.join(', ')}`
		deployReason = manifest.todos.join('\n')
		await emit({ type: 'log', payload: { message: `${note}\n${manifest.todos.join('\n')}` } }).catch(
			() => {}
		)
	}
	// D1 (docs/DELIVERED-DB.md): an app that needs a real database gets its own one provisioned
	// through the api (the job never holds admin DB credentials, only the scoped URL that comes
	// back) — or, when provisioning is unavailable or fails, NO deploy at all: a live URL whose
	// every read/write 500s against a database that does not exist is worse than no URL.
	// Set by any pre-deploy resource check that could not be satisfied. A missing dependency is
	// never degraded into a live-but-broken URL — the repo and bundle still deliver, the deploy
	// does not.
	let deployBlocked: string | undefined
	const dbNeed = await detectDatabaseNeed(repoDir, manifest.required)
	if (dbNeed.needed && !dryRun) {
		if (!dbProvisioner) {
			deployBlocked = `the app needs a database (${dbNeed.evidence.join('; ')}) but database provisioning is not configured — deploy skipped instead of shipping a live-but-dead app`
		} else {
			try {
				const { databaseUrl } = await dbProvisioner.provision({ signal })
				manifest.env.DATABASE_URL = databaseUrl
				manifest.placeholders = manifest.placeholders.filter(name => name !== 'DATABASE_URL')
				manifest.todos = manifest.todos.filter(todo => !todo.includes('DATABASE_URL'))
				// The placeholder TODO for DATABASE_URL is resolved now — recompute the step reason
				deployReason = manifest.todos.length ? manifest.todos.join('\n') : undefined
				await emit({
					type: 'log',
					payload: { message: `database provisioned for the delivered app (${dbNeed.evidence.join('; ')})` },
				}).catch(() => {})
			} catch (error) {
				deployBlocked = `database provisioning failed: ${(error as Error).message} — deploy skipped (the app needs a database: ${dbNeed.evidence.join('; ')})`
			}
		}
	}
	// Object storage (docs/PREVIEW-RESOURCES.md): same contract as the database above. An app that
	// takes uploads and has nowhere to put them either 500s on every upload or — worse — writes to
	// the container's ephemeral disk and silently loses the files on the next deployment, which
	// looks like it works right up until it doesn't.
	let storageRoleArn: string | undefined
	const storageNeed = await detectStorageNeed(repoDir, manifest.required)
	if (storageNeed.needed && !deployBlocked && !dryRun) {
		if (!storageProvisioner) {
			deployBlocked = `the app needs object storage (${storageNeed.evidence.join('; ')}) but storage provisioning is not configured — deploy skipped instead of shipping an app that cannot store what it is given`
		} else {
			try {
				const storage = await storageProvisioner.provision({ signal })
				storageRoleArn = storage.roleArn
				// The app reads its credentials from the task metadata endpoint (the role below), so
				// only the NAMES go into the env — never a key.
				// The template's own names first (its objectStorage plugin reads exactly these — the
				// first live app kept its uploads in memory because only S3_* were injected), then the
				// generic ones a worker-written client might read
				manifest.env.ATTACHMENTS_BUCKET = storage.bucket
				manifest.env.ATTACHMENTS_PREFIX = storage.prefix
				manifest.env.S3_BUCKET = storage.bucket
				manifest.env.S3_PREFIX = storage.prefix
				manifest.env.AWS_REGION = storage.region
				for (const name of ['ATTACHMENTS_BUCKET', 'S3_BUCKET', 'AWS_S3_BUCKET', 'STORAGE_BUCKET', 'BUCKET_NAME']) {
					if (manifest.required.includes(name)) manifest.env[name] = storage.bucket
					manifest.placeholders = manifest.placeholders.filter(entry => entry !== name)
					manifest.todos = manifest.todos.filter(todo => !todo.includes(name))
				}
				deployReason = manifest.todos.length ? manifest.todos.join('\n') : undefined
				await emit({
					type: 'log',
					payload: {
						message: `object storage provisioned for the delivered app at ${storage.prefix} (${storageNeed.evidence.join('; ')})`,
					},
				}).catch(() => {})
			} catch (error) {
				deployBlocked = `object storage provisioning failed: ${(error as Error).message} — deploy skipped (the app needs storage: ${storageNeed.evidence.join('; ')})`
			}
		}
	}
	// Acceptance smoke: boot the built artifact before standing up a service. In-process green
	// (lint + vitest) does not prove `node src/index.ts` boots — an env-contract mismatch or a
	// CJS/ESM interop crash only shows here. A boot failure skips the deploy (no crashlooping 503).
	const bootResult =
		boot && !deployBlocked ? await boot.boot({ repoDir, env: manifest.env, signal }) : undefined
	if (deployBlocked) {
		deployReason = deployBlocked
	} else if (bootResult && !bootResult.ok) {
		deployReason = `acceptance boot: the built app did not start — ${bootResult.reason ?? 'no "Server listening"'}`
	} else {
		try {
			// Per-job CodeBuild source: this job's repo zip in S3, so the image build is of THIS repo
			const source = await uploadSource(jobId, repoDir, artifacts, signal)
			const deployed = await deploy.deployFromRepo({
				serviceName: previewServiceName(serviceJobId, target.slug),
				repositoryUrl,
				branch: 'main',
				source,
				// The full required set for the live container, so it runs and does not crashloop
				env: manifest.env,
				// Set only when storage was provisioned; scoped to this app's prefix alone
				...(storageRoleArn && { taskRoleArn: storageRoleArn }),
				signal,
			})
			deployUrl = deployed.url
			// The service the deploy stood up, so the api records it per order (teardown targets ALL
			// of a rebuilt order's services; resume replays the recorded image/config to re-create it)
			deployedService = deployed.service
		} catch (error) {
			deployReason = `ecs express: ${(error as Error).message}`
		}
	}
	if (aborted()) return aborted()!
	let siteUrl: string | null = null
	try {
		const site = await uploadSite(jobId, repoDir, artifacts, signal, clients.knownSecrets)
		siteUrl = site.url
		if (site.reason) deployReason = deployReason ? `${deployReason}\n${site.reason}` : site.reason
	} catch (error) {
		deployReason = `${deployReason ? `${deployReason}\n` : ''}site upload: ${(error as Error).message}`
	}
	if (aborted()) return aborted()!
	await step({
		step: 'deploy',
		ok: deployUrl !== null,
		url: deployUrl ?? siteUrl ?? undefined,
		reason: deployReason,
	})
	if (deployUrl === null) {
		await emit({
			type: 'notify',
			payload: deployFailedNotification(jobId, repositoryUrl, deployReason ?? 'unknown'),
		}).catch(() => {})
	}
	if (aborted()) return aborted()!

	// MARK: acceptance (post-deploy end-to-end — visit the LIVE URL like the customer will)
	// A deployed service that fails this check is NOT handed out: `deployUrl` is withheld from the
	// deliverable (the service itself stays up, recorded, for the admins to inspect / tear down).
	if (deployUrl !== null && liveCheck) {
		const live = await liveCheck
			.check({ url: deployUrl, repoDir, signal })
			.catch(
				(error): LiveAcceptanceResult => ({
					ok: false,
					reason: `live acceptance check crashed: ${(error as Error).message}`,
					probes: [],
				})
			)
		await step({ step: 'acceptance', ok: live.ok, url: deployUrl, reason: live.reason })
		// The delivery-standard "Built by Mjukvaruhuset" footer (F5): recorded as information on
		// the live check's result and logged here — a missing footer never fails a delivery
		if (live.builtByFooter !== undefined) {
			await emit({
				type: 'log',
				payload: { message: builtByFooterLogLine(live.builtByFooter, deployUrl) },
			}).catch(() => {})
		}
		if (!live.ok) {
			const reason = live.reason ?? 'live acceptance check failed'
			deployReason = deployReason ? `${deployReason}\n${reason}` : reason
			await emit({
				type: 'notify',
				payload: acceptanceFailedNotification(jobId, deployUrl, reason),
			}).catch(() => {})
			deployUrl = null
		}
	}

	// MARK: bundle
	try {
		const files = await uploadBundle({
			jobId,
			repoDir,
			artifacts,
			docs: { 'HANDOVER.md': docs['HANDOVER.md'], 'TEST-REPORT.md': docs['TEST-REPORT.md'] },
			gatesJson: JSON.stringify(gates, null, 2),
			acceptanceJson: JSON.stringify(acceptanceReportOf(gates) ?? {}, null, 2),
			signal,
		})
		const deliverable: Deliverable = {
			jobId,
			repositoryUrl,
			transferPending: transferPending !== undefined,
			deployUrl,
			// Carried whenever a service was actually stood up — even when the live acceptance check
			// failed and the URL was withheld, the service exists and must be teardownable
			...(deployedService && { deployedService }),
			siteUrl,
			deliverableKey: deliverableKeyOf(jobId),
			files,
			deliveredAt: new Date(now()).toISOString(),
		}
		await step({
			step: 'bundle',
			ok: true,
			url: artifacts.urlOf(deliverable.deliverableKey),
			deliverable,
		})
		return { ok: true, tokens, deliverable, reason: deployReason, steps }
	} catch (error) {
		const reason = `bundle: ${(error as Error).message}`
		await step({ step: 'bundle', ok: false, reason })
		return fail(reason)
	}
}
