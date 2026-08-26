import { deliverableKeyOf, uploadBundle, uploadSite } from './bundle.ts'
import { writeDocs } from './docs.ts'
import { defaultGitHubOrg } from './github.ts'
import { acceptanceReportOf } from './types.ts'

import { exec } from '#job/exec.ts'
import { totalTokens } from '#job/types.ts'

import type { Deliverable, DeliveryEventPayload, NotifyPayload } from '@mf/models'
import type { TokenUsage } from '#job/types.ts'
import type { DeliveryClients, DeliveryInput, DeliveryOutcome } from './types.ts'

const commitDocs = async (repoDir: string, signal: AbortSignal) => {
	await exec('git', ['add', '-A'], { cwd: repoDir, signal })
	await exec('git', ['commit', '-q', '-m', 'docs: handover, test report and App Runner config'], {
		cwd: repoDir,
		signal,
	})
}

/** The `notify` payload for a delivered job whose preview deployment failed */
export const deployFailedNotification = (
	jobId: string,
	repositoryUrl: string,
	reason: string
): NotifyPayload => ({
	to: 'admins',
	subject: `Build job ${jobId} delivered without a preview URL`,
	text: `Job ${jobId} was delivered (repo ${repositoryUrl} + bundle uploaded) but the App Runner deployment failed:\n\n${reason}\n\nDeploy it by hand or re-run the delivery.`,
})

/**
 * Delivery after green gates, in four steps that each emit a `delivery` event:
 *   docs   — HANDOVER.md / TEST-REPORT.md / README.md / apprunner.yaml written + committed
 *   repo   — private GitHub repo `mjukvaruhuset/<slug>`, main pushed, customer added as admin
 *   deploy — App Runner service from the pushed repo + SPA build to the artifacts bucket
 *   bundle — repo.zip, docs and the gate/acceptance reports under `deliverables/<jobId>/`
 * The repo push and the bundle are the contract (`ok`); a failed deploy leaves `deployUrl`
 * null and raises a `notify` event for the admins. Docs failures are not fatal either.
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
	const { github, deploy, artifacts, prose, githubOrg = defaultGitHubOrg, dryRun } = clients
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
	let transferPending = !target.customerGithubLogin
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
				transferPending = true
				await emit({
					type: 'log',
					payload: { message: `add collaborator failed: ${(error as Error).message}` },
				}).catch(() => {})
			}
		}
		await step({
			step: 'repo',
			ok: true,
			url: repo.url,
			reason: transferPending ? 'transfer pending: no customer GitHub login' : undefined,
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
	try {
		deployUrl = (
			await deploy.deployFromRepo({
				serviceName: `mf-${target.slug}-${jobId.slice(0, 8)}`,
				repositoryUrl,
				branch: 'main',
			})
		).url
	} catch (error) {
		deployReason = `app runner: ${(error as Error).message}`
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
			transferPending,
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
