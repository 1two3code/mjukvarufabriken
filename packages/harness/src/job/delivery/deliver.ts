import { deliverableKeyOf, uploadBundle, uploadSite, uploadSource } from './bundle.ts'
import { writeDocs } from './docs.ts'
import { defaultGitHubOrg } from './github.ts'
import { acceptanceReportOf } from './types.ts'

import { git } from '#job/exec.ts'
import { totalTokens } from '#job/types.ts'

import type { Deliverable, DeliveryEventPayload, NotifyPayload } from '@mf/models'
import type { TokenUsage } from '#job/types.ts'
import type { DeliveryClients, DeliveryInput, DeliveryOutcome, PreviewAuth } from './types.ts'

/**
 * The runtime env the boot smoke injects. Today only the template's auth contract (the same
 * `previewAuth` the deploy passes to the container). Generated apps evolve their own required
 * env (own JWT secret, web-push VAPID keys, …); injecting those needs an app-declared env
 * manifest — a follow-up (TODO-EXTERNAL), tracked in wave7 stream 8.
 */
export const bootEnvOf = (previewAuth?: PreviewAuth): Record<string, string> =>
	previewAuth
		? {
				AUTH_ISSUER: previewAuth.issuer,
				AUTH_JWKS_URL: previewAuth.jwksUrl,
				AUTH_AUDIENCE: previewAuth.audience,
			}
		: {}

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
 * Delivery after green gates, in four steps that each emit a `delivery` event:
 *   docs   — HANDOVER.md / TEST-REPORT.md / README.md written + committed
 *   repo   — private GitHub repo `mjukvaruhuset/<slug>`, main pushed, customer added as admin
 *   deploy — ECS Express service (built image → managed URL) + SPA build to the artifacts bucket
 *   bundle — repo.zip, docs and the gate/acceptance reports under `deliverables/<jobId>/`
 * The repo push and the bundle are the contract (`ok`); a failed deploy leaves `deployUrl`
 * null and raises a `notify` event for the admins. A docs failure is fatal: without the commit
 * the repo and the archive would be wrong.
 */
export const deliver = async (
	{
		jobId,
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
		await commitDocs(repoDir, signal)
		await step({ step: 'docs', ok: true })
	} catch (error) {
		return fail(`handover docs failed: ${(error as Error).message}`)
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
	let deployReason: string | undefined
	// Acceptance smoke: boot the built artifact before standing up a service. In-process green
	// (lint + vitest) does not prove `node src/index.ts` boots — an env-contract mismatch or a
	// CJS/ESM interop crash only shows here. A boot failure skips the deploy (no crashlooping 503).
	const bootResult = boot ? await boot.boot({ repoDir, env: bootEnvOf(previewAuth), signal }) : undefined
	if (bootResult && !bootResult.ok) {
		deployReason = `acceptance boot: the built app did not start — ${bootResult.reason ?? 'no "Server listening"'}`
	} else {
		try {
			// Per-job CodeBuild source: this job's repo zip in S3, so the image build is of THIS repo
			const source = await uploadSource(jobId, repoDir, artifacts, signal)
			deployUrl = (
				await deploy.deployFromRepo({
					serviceName: previewServiceName(jobId, target.slug),
					repositoryUrl,
					branch: 'main',
					source,
					signal,
				})
			).url
		} catch (error) {
			deployReason = `ecs express: ${(error as Error).message}`
		}
	}
	if (aborted()) return aborted()!
	let siteUrl: string | null = null
	try {
		const site = await uploadSite(jobId, repoDir, artifacts, signal)
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
