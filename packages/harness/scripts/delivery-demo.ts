/**
 * Runs ONLY the M5 delivery step (handover docs → GitHub repo → ECS Express → S3 bundle) on an
 * already-built repo directory. With `--dry-run` every external call is logged instead of made
 * (no token, roles or bucket needed); without it the live clients read GITHUB_APP_*,
 * ECR_REPOSITORY_URI, CODEBUILD_PROJECT, EXPRESS_EXECUTION_ROLE_ARN,
 * EXPRESS_INFRASTRUCTURE_ROLE_ARN, ECS_CLUSTER and ARTIFACTS_BUCKET from the env.
 *
 *   npm run delivery:demo -- --repo <dir> --dry-run [--spec spec.json] [--gates gates.json]
 *       [--slug gym-booking] [--name "Gym booking"] [--github-login octocat] [--no-prose]
 *
 * NOTE: the docs step commits HANDOVER.md, TEST-REPORT.md and README.md on
 * the repo's current branch (main) — run it on a scratch clone, not your working copy. The
 * handover prose session needs ANTHROPIC_API_KEY; without it (or with --no-prose) the spec
 * goal is used. Exits 0 when the delivery contract (repo + bundle) held.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { z } from 'zod'
import { GateReportSchema, SpecSchema } from '@mf/models'

import { BudgetTracker } from '#job/budget.ts'
import { deliver } from '#job/delivery/deliver.ts'
import { appNameOf, createLiveDeliveryClients, slugify } from '#job/delivery/index.ts'

const { values } = parseArgs({
	options: {
		repo: { type: 'string' },
		spec: { type: 'string' },
		gates: { type: 'string' },
		slug: { type: 'string' },
		name: { type: 'string' },
		'github-login': { type: 'string' },
		'dry-run': { type: 'boolean', default: false },
		'no-prose': { type: 'boolean', default: false },
		'job-id': { type: 'string', default: `demo-${Date.now().toString(36)}` },
	},
})

if (!values.repo) {
	console.error(
		'usage: delivery-demo --repo <dir> [--dry-run] [--spec spec.json] [--gates gates.json] [--slug x] [--name "X"] [--github-login x] [--no-prose]'
	)
	process.exit(64)
}

const readJson = async (path: string) =>
	JSON.parse(await readFile(resolve(path), 'utf8')) as unknown
const spec = values.spec
	? SpecSchema.parse(await readJson(values.spec))
	: {
			goal: 'Demo application built from a local repository',
			users: [],
			features: [],
			nonGoals: [],
			stackConstraints: [],
		}
const gates = values.gates ? z.array(GateReportSchema).parse(await readJson(values.gates)) : []
const repoDir = resolve(values.repo)
const target = {
	slug: values.slug ?? slugify(values.name ?? spec.goal),
	appName: values.name ?? appNameOf(spec.goal),
	customerGithubLogin: values['github-login'],
}

const clients = createLiveDeliveryClients({
	dryRun: values['dry-run'],
	githubApp:
		process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_INSTALLATION_ID
			? {
					appId: process.env.GITHUB_APP_ID,
					privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
					installationId: Number(process.env.GITHUB_APP_INSTALLATION_ID),
				}
			: undefined,
	ecrRepositoryUri: process.env.ECR_REPOSITORY_URI,
	codeBuildProject: process.env.CODEBUILD_PROJECT,
	expressExecutionRoleArn: process.env.EXPRESS_EXECUTION_ROLE_ARN,
	expressInfrastructureRoleArn: process.env.EXPRESS_INFRASTRUCTURE_ROLE_ARN,
	cluster: process.env.ECS_CLUSTER,
	previewAuth: process.env.PREVIEW_AUTH_ISSUER
		? {
				issuer: process.env.PREVIEW_AUTH_ISSUER,
				jwksUrl:
					process.env.PREVIEW_AUTH_JWKS_URL ??
					`${process.env.PREVIEW_AUTH_ISSUER.replace(/\/$/, '')}/.well-known/jwks.json`,
				audience: process.env.PREVIEW_AUTH_AUDIENCE ?? 'mjukvaruhuset',
			}
		: undefined,
	artifactsBucket: process.env.ARTIFACTS_BUCKET,
	log: line => console.log(line),
})
if (values['no-prose'] || !process.env.ANTHROPIC_API_KEY) clients.prose = undefined

const budget = new BudgetTracker({ maxTokens: 500_000, maxDurationMinutes: 60, maxWorkers: 1 })
console.log(
	`repo: ${repoDir}\ntarget: mjukvaruhuset/${target.slug} (${target.appName})\nmode: ${values['dry-run'] ? 'dry-run' : 'LIVE'}\nprose: ${clients.prose ? 'agent session' : 'spec goal'}\n`
)
const startedAt = Date.now()
const outcome = await deliver(
	{
		jobId: values['job-id']!,
		spec,
		gates,
		repoDir,
		target,
		signal: budget.signal,
		onUsage: usage => budget.add(usage),
		emit: async event => {
			console.log(`event ${event.type}: ${JSON.stringify(event.payload)}`)
		},
	},
	clients
)

console.log('\n=== outcome')
console.log(JSON.stringify(outcome, null, 2))
console.log(
	`\n${outcome.ok ? 'DELIVERED' : `FAILED: ${outcome.reason}`} — ${budget.used} budget-tokens, ${Math.round((Date.now() - startedAt) / 1000)} s`
)
process.exit(outcome.ok ? 0 : 1)
