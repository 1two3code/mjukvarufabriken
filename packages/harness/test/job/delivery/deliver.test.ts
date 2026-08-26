import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeDeployClient } from '#job/delivery/appRunner.ts'
import { createFakeArtifactStore } from '#job/delivery/artifacts.ts'
import { deliver } from '#job/delivery/deliver.ts'
import { createFakeGitHubClient } from '#job/delivery/github.ts'
import { createLiveDeliveryClients } from '#job/delivery/index.ts'
import { createFakeProseWriter } from '#job/delivery/prose.ts'
import { exec } from '#job/exec.ts'

import type { GateReport, NewJobEvent, Spec } from '@mf/models'
import type { DeliveryClients, DeliveryInput } from '#job/delivery/types.ts'

// MARK: Fixtures

const spec: Spec = {
	goal: 'A booking app for a small gym',
	users: ['members'],
	features: [
		{
			title: 'Book a class',
			description: 'Members book a spot',
			acceptanceCriteria: ['A member can book a class'],
		},
	],
	nonGoals: ['Payments'],
	stackConstraints: [],
}

const gates: GateReport[] = [
	{
		name: 'verify',
		ok: true,
		startedAt: '2026-08-26T10:00:00.000Z',
		durationMs: 1000,
		tokens: 0,
		summary: 'npm run lint: ok\nnpm run test: ok',
	},
	{
		name: 'review',
		ok: true,
		startedAt: '2026-08-26T10:00:01.000Z',
		durationMs: 1000,
		tokens: 10,
		summary: '1 finding(s), none high/medium open',
		details: {
			findings: [
				{
					id: 'apps/api/src/x.ts:3',
					severity: 'low',
					file: 'apps/api/src/x.ts',
					line: 3,
					claim: 'Unbounded list',
					failureScenario: 'Large list',
				},
			],
		},
	},
	{
		name: 'acceptance-check',
		ok: true,
		startedAt: '2026-08-26T10:00:02.000Z',
		durationMs: 1000,
		tokens: 10,
		summary: 'met',
		details: {
			report: { 'f0.c0': { status: 'met', evidence: ['apps/app/acceptance/f0.c0.test.ts'] } },
		},
	},
]

const gitEnv = {
	GIT_AUTHOR_NAME: 't',
	GIT_AUTHOR_EMAIL: 't@t',
	GIT_COMMITTER_NAME: 't',
	GIT_COMMITTER_EMAIL: 't@t',
}

/** A tiny git repo whose `npm run build` produces an SPA dist */
const createRepo = async (root: string) => {
	const repoDir = join(root, 'repo')
	await mkdir(repoDir, { recursive: true })
	await writeFile(
		join(repoDir, 'README.md'),
		'# Template\n\nTemplate intro.\n\n## Commands\n\nnpm i\n'
	)
	await writeFile(
		join(repoDir, 'package.json'),
		JSON.stringify({
			name: 'customer-app',
			scripts: {
				build:
					'mkdir -p apps/app/dist/live/assets && echo "<html/>" > apps/app/dist/live/index.html && echo "x" > apps/app/dist/live/assets/a.js',
			},
		})
	)
	await writeFile(join(repoDir, '.gitignore'), 'dist\nnode_modules\n')
	const run = (args: string[]) => exec('git', args, { cwd: repoDir, env: gitEnv })
	await run(['init', '-q', '-b', 'main'])
	await run(['add', '-A'])
	await run(['commit', '-q', '-m', 'chore: seed'])
	return repoDir
}

const createInput = (
	repoDir: string,
	overrides: Partial<DeliveryInput> = {}
): DeliveryInput & { events: NewJobEvent[] } => {
	const events: NewJobEvent[] = []
	return {
		jobId: '11111111-2222-3333-4444-555555555555',
		spec,
		plan: {
			summary: 'one task',
			tasks: [
				{
					id: 'book',
					title: 'Booking',
					description: 'x',
					dependsOn: [],
					areas: [],
					acceptanceCriteriaIds: ['f0.c0'],
				},
			],
		},
		gates,
		repoDir,
		target: { slug: 'gym-booking', appName: 'Gym booking', customerGithubLogin: 'octocat' },
		signal: new AbortController().signal,
		onUsage: vi.fn(),
		emit: async event => {
			events.push(event)
		},
		now: () => Date.UTC(2026, 7, 26, 12),
		events,
		...overrides,
	}
}

const createClients = (overrides: Partial<DeliveryClients> = {}) => {
	const github = createFakeGitHubClient()
	const deploy = createFakeDeployClient()
	const artifacts = createFakeArtifactStore()
	const clients: DeliveryClients = {
		github,
		deploy,
		artifacts,
		prose: createFakeProseWriter('The gym app lets members book classes.'),
		...overrides,
	}
	return { github, deploy, artifacts, clients }
}

// MARK: Tests

describe('deliver', () => {
	let root: string
	let repoDir: string
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mf-deliver-'))
		repoDir = await createRepo(root)
	})
	afterEach(() => rm(root, { recursive: true, force: true }))

	it('Writes + commits the handover docs, pushes the repo, deploys and uploads the bundle', async () => {
		// Arrange
		const { github, deploy, artifacts, clients } = createClients()
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert
		expect(outcome.ok).toBe(true)
		expect(outcome.tokens).toBe(250)
		expect(input.events.map(event => event.type)).toEqual([
			'delivery',
			'delivery',
			'delivery',
			'delivery',
		])
		expect(outcome.steps.map(step => `${step.step}:${step.ok}`)).toEqual([
			'docs:true',
			'repo:true',
			'deploy:true',
			'bundle:true',
		])

		// docs committed on main, README refreshed, prose used
		const log = await exec('git', ['log', '--oneline'], { cwd: repoDir })
		expect(log.stdout).toMatch(/docs: handover/)
		const handover = await readFile(join(repoDir, 'HANDOVER.md'), 'utf8')
		expect(handover).toContain('# Gym booking — handover')
		expect(handover).toContain('The gym app lets members book classes.')
		expect(handover).toContain('| verify | OK |')
		expect(handover).toContain('`apps/api/src/x.ts:3` — Unbounded list')
		const readme = await readFile(join(repoDir, 'README.md'), 'utf8')
		expect(readme.startsWith('# Gym booking\n')).toBe(true)
		expect(readme).toContain('## Commands')
		expect(readme).not.toContain('# Template\n')
		const testReport = await readFile(join(repoDir, 'TEST-REPORT.md'), 'utf8')
		expect(testReport).toContain('| f0.c0 | Book a class | A member can book a class | met |')
		expect(await readFile(join(repoDir, 'apprunner.yaml'), 'utf8')).toContain('runtime: nodejs22')

		// GitHub
		expect(github.repos).toEqual([
			expect.objectContaining({ org: 'mjukvaruhuset', name: 'gym-booking' }),
		])
		expect(github.pushes).toEqual([
			{ repoDir, cloneUrl: 'https://github.com/mjukvaruhuset/gym-booking.git', branch: 'main' },
		])
		expect(github.collaborators).toEqual([
			{ org: 'mjukvaruhuset', name: 'gym-booking', login: 'octocat', permission: 'admin' },
		])

		// App Runner + site
		expect(deploy.deployments).toEqual([
			{
				serviceName: 'mf-gym-booking-11111111',
				repositoryUrl: 'https://github.com/mjukvaruhuset/gym-booking',
				branch: 'main',
			},
		])
		const prefix = 'deliverables/11111111-2222-3333-4444-555555555555/'
		expect([...artifacts.objects.keys()].sort()).toEqual(
			[
				`${prefix}HANDOVER.md`,
				`${prefix}TEST-REPORT.md`,
				`${prefix}acceptance.json`,
				`${prefix}gates.json`,
				`${prefix}repo.zip`,
				`${prefix}site/assets/a.js`,
				`${prefix}site/index.html`,
			].sort()
		)
		expect(artifacts.objects.get(`${prefix}repo.zip`)?.contentType).toBe('application/zip')
		expect(JSON.parse(artifacts.objects.get(`${prefix}acceptance.json`)!.body as string)).toEqual({
			'f0.c0': { status: 'met', evidence: ['apps/app/acceptance/f0.c0.test.ts'] },
		})

		// The record
		expect(outcome.deliverable).toEqual({
			jobId: '11111111-2222-3333-4444-555555555555',
			repositoryUrl: 'https://github.com/mjukvaruhuset/gym-booking',
			transferPending: false,
			deployUrl: 'https://mf-gym-booking-11111111.eu-north-1.awsapprunner.com',
			siteUrl: `https://mf-artifacts-test.s3.eu-north-1.amazonaws.com/${prefix}site/index.html`,
			deliverableKey: prefix,
			files: [
				{ name: 'repo.zip', key: `${prefix}repo.zip`, size: expect.any(Number) },
				{ name: 'HANDOVER.md', key: `${prefix}HANDOVER.md`, size: expect.any(Number) },
				{ name: 'TEST-REPORT.md', key: `${prefix}TEST-REPORT.md`, size: expect.any(Number) },
				{ name: 'gates.json', key: `${prefix}gates.json`, size: expect.any(Number) },
				{ name: 'acceptance.json', key: `${prefix}acceptance.json`, size: expect.any(Number) },
			],
			deliveredAt: '2026-08-26T12:00:00.000Z',
		})
		expect(outcome.steps[3]!.deliverable).toEqual(outcome.deliverable)
	})

	it('Leaves the transfer pending when the customer has no GitHub login', async () => {
		// Arrange
		const { github, clients } = createClients()
		const input = createInput(repoDir, { target: { slug: 'gym', appName: 'Gym' } })

		// Act
		const outcome = await deliver(input, clients)

		// Assert
		expect(outcome.ok).toBe(true)
		expect(github.collaborators).toEqual([])
		expect(outcome.deliverable?.transferPending).toBe(true)
		expect(outcome.steps[1]).toEqual({
			step: 'repo',
			ok: true,
			url: 'https://github.com/mjukvaruhuset/gym',
			reason: 'transfer pending: no customer GitHub login',
		})
	})

	it('Still delivers when the deploy fails: deployUrl null + a notify event for the admins', async () => {
		// Arrange
		const { clients } = createClients({ deploy: createFakeDeployClient(true) })
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert
		expect(outcome.ok).toBe(true)
		expect(outcome.deliverable?.deployUrl).toBeNull()
		expect(outcome.deliverable?.siteUrl).toMatch(/site\/index\.html$/)
		expect(outcome.reason).toBe('app runner: fake: App Runner deploy failed')
		expect(outcome.steps[2]).toEqual({
			step: 'deploy',
			ok: false,
			url: outcome.deliverable?.siteUrl,
			reason: 'app runner: fake: App Runner deploy failed',
		})
		const notify = input.events.find(event => event.type === 'notify')
		expect(notify?.payload).toEqual({
			to: 'admins',
			subject: 'Build job 11111111-2222-3333-4444-555555555555 delivered without a preview URL',
			text: expect.stringContaining('App Runner deployment failed'),
		})
	})

	it('Fails closed when the push fails — no deploy, no bundle', async () => {
		// Arrange
		const { deploy, artifacts, clients } = createClients({
			github: createFakeGitHubClient('push'),
		})
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert
		expect(outcome.ok).toBe(false)
		expect(outcome.reason).toBe('github: fake: push failed')
		expect(outcome.deliverable).toBeUndefined()
		expect(outcome.steps.map(step => `${step.step}:${step.ok}`)).toEqual([
			'docs:true',
			'repo:false',
		])
		expect(deploy.deployments).toEqual([])
		expect(artifacts.objects.size).toBe(0)
	})

	it('Keeps the repo delivered but flags the transfer when the invitation fails', async () => {
		// Arrange
		const { clients } = createClients({ github: createFakeGitHubClient('addCollaborator') })
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert
		expect(outcome.ok).toBe(true)
		expect(outcome.deliverable?.transferPending).toBe(true)
		expect(input.events.find(event => event.type === 'log')?.payload.message).toMatch(
			/add collaborator failed/
		)
	})

	it('Fails when the bundle upload fails', async () => {
		// Arrange
		const { clients } = createClients({ artifacts: createFakeArtifactStore('b', true) })
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert
		expect(outcome.ok).toBe(false)
		expect(outcome.reason).toBe('bundle: fake: putObject failed')
		expect(outcome.steps.at(-1)).toEqual({
			step: 'bundle',
			ok: false,
			reason: 'bundle: fake: putObject failed',
		})
	})

	it('Falls back to the spec goal when the prose session fails', async () => {
		// Arrange
		const { clients } = createClients({
			prose: async () => {
				throw new Error('no model')
			},
		})
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert
		expect(outcome.ok).toBe(true)
		const handover = await readFile(join(repoDir, 'HANDOVER.md'), 'utf8')
		expect(handover).toContain('## What was built\n\nA booking app for a small gym\n')
	})

	it('Stops with "aborted" when the budget signal fires', async () => {
		// Arrange
		const controller = new AbortController()
		const { clients } = createClients({
			github: {
				...createFakeGitHubClient(),
				push: async () => controller.abort('budget exceeded'),
			},
		})
		const input = createInput(repoDir, { signal: controller.signal })

		// Act
		const outcome = await deliver(input, clients)

		// Assert
		expect(outcome).toMatchObject({ ok: false, reason: 'aborted' })
		expect(outcome.steps.map(step => step.step)).toEqual(['docs', 'repo'])
	})

	it('Dry run: logs every external call instead of making it and marks the events', async () => {
		// Arrange
		const lines: string[] = []
		const clients = createLiveDeliveryClients({
			dryRun: true,
			artifactsBucket: 'mf-artifacts-dev',
			log: line => lines.push(line),
		})
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert
		expect(outcome.ok).toBe(true)
		expect(outcome.steps.every(step => step.dryRun)).toBe(true)
		expect(lines).toEqual(
			expect.arrayContaining([
				'[dry-run] github: create private repo mjukvaruhuset/gym-booking',
				'[dry-run] github: push main → https://github.com/mjukvaruhuset/gym-booking.git',
				'[dry-run] github: add octocat as admin on mjukvaruhuset/gym-booking',
				'[dry-run] app runner: create service mf-gym-booking-11111111 from https://github.com/mjukvaruhuset/gym-booking#main',
				expect.stringMatching(
					/^\[dry-run\] s3: put s3:\/\/mf-artifacts-dev\/deliverables\/.*\/repo\.zip \(application\/zip, \d+ bytes\)$/
				),
			])
		)
		expect(outcome.deliverable?.deployUrl).toBe(
			'https://mf-gym-booking-11111111.eu-north-1.awsapprunner.com'
		)
	})

	it('Live clients without configuration fail the repo step with a TODO-EXTERNAL reason', async () => {
		// Arrange
		const clients = createLiveDeliveryClients({})
		const input = createInput(repoDir)

		// Act (the live prose writer needs the Agent SDK — swapped for none)
		const outcome = await deliver(input, { ...clients, prose: undefined })

		// Assert
		expect(outcome.ok).toBe(false)
		expect(outcome.reason).toBe('github: GITHUB_TOKEN is not configured (TODO-EXTERNAL)')
	})
})
