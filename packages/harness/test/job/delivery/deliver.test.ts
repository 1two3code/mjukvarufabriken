import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeDeployClient } from '#job/delivery/ecsExpress.ts'
import { createFakeArtifactStore } from '#job/delivery/artifacts.ts'
import { createFakeBootCheck } from '#job/delivery/bootArtifact.ts'
import { deliver } from '#job/delivery/deliver.ts'
import { createFakeGitHubClient } from '#job/delivery/github.ts'
import { createLiveDeliveryClients } from '#job/delivery/index.ts'
import { createFakeLiveCheck } from '#job/delivery/liveAcceptance.ts'
import { createFakeProseWriter } from '#job/delivery/prose.ts'
import { buildPushInvocation, pushBranch } from '#job/delivery/github.ts'
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

		// ECS Express + site
		expect(deploy.deployments).toEqual([
			{
				serviceName: 'mf-11111111-gym-booking',
				repositoryUrl: 'https://github.com/mjukvaruhuset/gym-booking',
				branch: 'main',
				source: { bucket: 'mf-artifacts-test', key: 'delivery-source/11111111-2222-3333-4444-555555555555.zip' },
			},
		])
		const prefix = 'deliverables/11111111-2222-3333-4444-555555555555/'
		expect([...artifacts.objects.keys()].sort()).toEqual(
			[
				'delivery-source/11111111-2222-3333-4444-555555555555.zip',
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
			deployUrl: 'https://mf-11111111-gym-booking.eu-north-1.on.aws',
			deployedService: {
				serviceName: 'mf-11111111-gym-booking',
				serviceArn:
					'arn:aws:ecs:eu-north-1:000000000000:service/default/mf-11111111-gym-booking',
				customerTag: 'gym-booking',
				image:
					'000000000000.dkr.ecr.eu-north-1.amazonaws.com/mf-deliverables:mf-11111111-gym-booking',
				config: expect.objectContaining({ serviceName: 'mf-11111111-gym-booking' }),
			},
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

	it('Reports why the transfer is pending when the invitation fails (the login exists)', async () => {
		// Arrange
		const { clients } = createClients({ github: createFakeGitHubClient('addCollaborator') })
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert — not "no customer GitHub login": the admin must re-check the login, not ask for one
		expect(outcome.ok).toBe(true)
		expect(outcome.deliverable?.transferPending).toBe(true)
		expect(outcome.steps[1]).toEqual({
			step: 'repo',
			ok: true,
			url: 'https://github.com/mjukvaruhuset/gym-booking',
			reason: 'transfer pending: adding octocat as admin failed: fake: addCollaborator failed',
		})
		expect(input.events.find(event => event.type === 'log')?.payload.message).toMatch(
			/adding octocat as admin failed/
		)
	})

	it('Fails closed when the docs cannot be committed — nothing is pushed without them', async () => {
		// Arrange — a stale index.lock (a session killed mid-git) makes `git add` exit 128
		await writeFile(join(repoDir, '.git', 'index.lock'), '')
		const { github, clients } = createClients()
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert
		expect(outcome.ok).toBe(false)
		expect(outcome.reason).toMatch(/^handover docs failed: git add -A failed \(128\)/)
		expect(outcome.steps).toEqual([])
		expect(github.pushes).toEqual([])
	})

	it('Never puts the GitHub token into the error of a failed push', async () => {
		// Arrange — pushing to a clone URL that does not exist fails fast
		const cloneUrl = 'https://github.com/mjukvaruhuset/does-not-exist.git'
		const token = 'ghp_SECRET_TOKEN_VALUE'

		// Act
		const error = await pushBranch(repoDir, cloneUrl, 'main', token).then(
			() => new Error('push unexpectedly succeeded'),
			e => e as Error
		)

		// Assert
		expect(error.message).toContain(`git push main → ${cloneUrl} failed`)
		expect(error.message).not.toContain(token)
		expect(error.message).not.toContain('x-access-token')
	})

	it('Never puts the token in git argv — only in the child env (hardening audit 2026-08-30, A3)', () => {
		// Arrange — /proc/<pid>/cmdline is world-readable with no hidepid; the token must never be
		// an argv element of the spawned `git` process, only reachable via its own environment
		const token = 'ghs_SECRET_INSTALLATION_TOKEN'

		// Act
		const { args, env } = buildPushInvocation('https://github.com/mjukvaruhuset/gym-booking.git', 'main', token)

		// Assert
		expect(args.some(arg => arg.includes(token))).toBe(false)
		expect(Object.values(env)).toContain(token)
	})

	it("Authenticates through git's own credential protocol with the token from the env", () => {
		// Arrange — exercises the real inline shell helper via `git credential fill`, no network:
		// proves the helper string is syntactically correct and actually resolves the token, not
		// just that it is absent from argv
		const token = 'ghs_SECRET_INSTALLATION_TOKEN'
		const { args, env } = buildPushInvocation('https://github.com/mjukvaruhuset/gym-booking.git', 'main', token)
		const credentialHelperArg = args[1]!

		// Act
		const child = execFileSync('git', ['-c', credentialHelperArg, 'credential', 'fill'], {
			input: 'protocol=https\nhost=github.com\n\n',
			encoding: 'utf8',
			env: { ...process.env, ...env },
		})

		// Assert
		expect(child).toContain(`password=${token}`)
		expect(child).toContain('username=x-access-token')
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
		expect(outcome.reason).toBe('ecs express: fake: ECS Express deploy failed')
		expect(outcome.steps[2]).toEqual({
			step: 'deploy',
			ok: false,
			url: outcome.deliverable?.siteUrl,
			reason: 'ecs express: fake: ECS Express deploy failed',
		})
		const notify = input.events.find(event => event.type === 'notify')
		expect(notify?.payload).toEqual({
			to: 'admins',
			subject: 'Build job 11111111-2222-3333-4444-555555555555 delivered without a preview URL',
			text: expect.stringContaining('ECS Express deployment failed'),
		})
	})

	it('Skips the deploy when the acceptance boot fails — no service is stood up, admins notified', async () => {
		// Arrange — the built artifact would crashloop (env-contract / CJS-ESM crash)
		const deploy = createFakeDeployClient()
		const boot = createFakeBootCheck({ ok: false, output: '', reason: "no 'Server listening'" })
		const { clients } = createClients({ deploy, boot })
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert — delivery still ok (repo + bundle), but no deploy attempted, boot reason surfaced
		expect(outcome.ok).toBe(true)
		expect(outcome.deliverable?.deployUrl).toBeNull()
		expect(deploy.deployments).toEqual([])
		expect(outcome.steps[2]).toMatchObject({ step: 'deploy', ok: false })
		expect(outcome.steps[2]!.reason).toContain('acceptance boot')
		const notify = input.events.find(event => event.type === 'notify')
		expect(notify?.payload).toMatchObject({ to: 'admins' })
	})

	it('Boots the built artifact with the preview auth env, then deploys when it is green', async () => {
		// Arrange
		const deploy = createFakeDeployClient()
		const boot = createFakeBootCheck({ ok: true, output: 'Server listening' })
		const previewAuth = {
			issuer: 'https://api.mjukvaruhuset.se',
			jwksUrl: 'https://api.mjukvaruhuset.se/.well-known/jwks.json',
			audience: 'preview',
		}
		const { clients } = createClients({ deploy, boot, previewAuth })
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert — the boot ran with the repo + the auth contract env, and the deploy went ahead
		expect(boot.calls).toHaveLength(1)
		expect(boot.calls[0]!.repoDir).toBe(repoDir)
		expect(boot.calls[0]!.env).toMatchObject({
			AUTH_ISSUER: previewAuth.issuer,
			AUTH_JWKS_URL: previewAuth.jwksUrl,
			AUTH_AUDIENCE: previewAuth.audience,
		})
		// generated app secrets so an app requiring them boots in the smoke check
		expect(Object.keys(boot.calls[0]!.env ?? {})).toEqual(
			expect.arrayContaining(['AUTH_JWT_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'])
		)
		expect(deploy.deployments).toHaveLength(1)
		expect(outcome.steps[2]).toMatchObject({ step: 'deploy', ok: true })
	})

	it('Injects the app-declared required env into BOTH the boot check and the deploy container', async () => {
		// Arrange — a repo whose secrets plugin requires a non-template var (family-hub #2 shape):
		// a self-issued secret (generated) and an external one (placeholder + TODO surfaced)
		await mkdir(join(repoDir, 'apps/api/src/plugins'), { recursive: true })
		await writeFile(
			join(repoDir, 'apps/api/src/plugins/secrets.ts'),
			`const required = ['AUTH_JWT_SECRET', 'APP_SIGNING_SECRET', 'MAPBOX_TOKEN'] as const\n`
		)
		const deploy = createFakeDeployClient()
		const boot = createFakeBootCheck({ ok: true, output: 'Server listening' })
		const { clients } = createClients({ deploy, boot })
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert — the boot smoke got the full resolved set: app secrets + the generated self-issued
		// secret + a flagged placeholder for the external one
		const bootEnv = boot.calls[0]!.env
		expect(Object.keys(bootEnv)).toEqual(
			expect.arrayContaining(['AUTH_JWT_SECRET', 'VAPID_PUBLIC_KEY', 'APP_SIGNING_SECRET', 'MAPBOX_TOKEN'])
		)
		expect(bootEnv.APP_SIGNING_SECRET).toBeTruthy()
		expect(bootEnv.APP_SIGNING_SECRET!.startsWith('TODO_SET_BY_OPERATOR_')).toBe(false)
		expect(bootEnv.MAPBOX_TOKEN).toBe('TODO_SET_BY_OPERATOR_MAPBOX_TOKEN')

		// The SAME full set was injected into the live deploy container, so it runs (not just boots)
		expect(deploy.envs[0]).toEqual(bootEnv)

		// The placeholder is surfaced to the operator, not silently omitted
		const log = input.events.find(
			event => event.type === 'log' && /MAPBOX_TOKEN/.test((event.payload as { message: string }).message)
		)
		expect(log).toBeTruthy()
		expect(outcome.steps[2]).toMatchObject({ step: 'deploy', ok: true })
	})

	it('Runs the live acceptance check after the deploy and keeps the URL when it is green', async () => {
		// Arrange
		const liveCheck = createFakeLiveCheck({ ok: true, probes: [] })
		const { clients } = createClients({ liveCheck })
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert — the check probed the LIVE url and the deliverable keeps it
		expect(liveCheck.calls).toHaveLength(1)
		expect(liveCheck.calls[0]!.url).toBe(outcome.deliverable!.deployUrl)
		expect(liveCheck.calls[0]!.repoDir).toBe(repoDir)
		expect(outcome.steps.map(step => `${step.step}:${step.ok}`)).toEqual([
			'docs:true',
			'repo:true',
			'deploy:true',
			'acceptance:true',
			'bundle:true',
		])
	})

	it('Withholds the URL but keeps the service recorded when the live acceptance check fails', async () => {
		// Arrange — the guestbook shape caught live: the probe reports the visitor locked out
		const liveCheck = createFakeLiveCheck({
			ok: false,
			reason: 'GET /bff/guestbook: 401 for an anonymous visitor and not in publicUrls',
			probes: [{ method: 'GET', path: '/guestbook', status: 401, ok: false }],
		})
		const { clients } = createClients({ liveCheck })
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert — still delivered (repo + bundle), but NO working-URL claim; admins paged
		expect(outcome.ok).toBe(true)
		expect(outcome.deliverable?.deployUrl).toBeNull()
		// The service exists and must stay teardownable even though the URL was withheld
		expect(outcome.deliverable?.deployedService).toBeTruthy()
		expect(outcome.steps.find(step => step.step === 'acceptance')).toMatchObject({
			ok: false,
			reason: expect.stringContaining('401'),
		})
		const notify = input.events.find(event => event.type === 'notify')
		expect(notify?.payload).toMatchObject({
			subject: expect.stringContaining('FAILED the live acceptance check'),
		})
		expect(outcome.reason).toContain('401')
	})

	it('Skips the deploy when the app needs a database and no provisioner is configured', async () => {
		// Arrange — D1: a required DATABASE_URL used to ship as a placeholder into a live container
		await mkdir(join(repoDir, 'apps/api/src/plugins'), { recursive: true })
		await writeFile(
			join(repoDir, 'apps/api/src/plugins/secrets.ts'),
			`const required = ['DATABASE_URL'] as const\n`
		)
		const deploy = createFakeDeployClient()
		const boot = createFakeBootCheck()
		const { clients } = createClients({ deploy, boot })
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert — fail closed: no boot, no service, the reason names the database need
		expect(deploy.deployments).toEqual([])
		expect(boot.calls).toEqual([])
		expect(outcome.deliverable?.deployUrl).toBeNull()
		expect(outcome.steps[2]).toMatchObject({ step: 'deploy', ok: false })
		expect(outcome.steps[2]!.reason).toContain('needs a database')
		expect(outcome.steps[2]!.reason).toContain('DATABASE_URL')
	})

	it('Provisions the database and injects DATABASE_URL into both the boot and the live container', async () => {
		// Arrange
		await mkdir(join(repoDir, 'apps/api/src/plugins'), { recursive: true })
		await writeFile(
			join(repoDir, 'apps/api/src/plugins/secrets.ts'),
			`const required = ['DATABASE_URL'] as const\n`
		)
		const databaseUrl = 'postgres://mf_app_11111111:pw@db.internal:5432/mf_app_11111111'
		const dbProvisioner = { provision: vi.fn().mockResolvedValue({ databaseUrl }) }
		const deploy = createFakeDeployClient()
		const boot = createFakeBootCheck()
		const { clients } = createClients({ deploy, boot, dbProvisioner })
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert — the scoped URL (never admin creds) reached the boot smoke AND the live container,
		// and no DATABASE_URL operator-TODO is left on the step
		expect(dbProvisioner.provision).toHaveBeenCalledTimes(1)
		expect(boot.calls[0]!.env.DATABASE_URL).toBe(databaseUrl)
		expect(deploy.envs[0]!.DATABASE_URL).toBe(databaseUrl)
		expect(outcome.steps[2]).toMatchObject({ step: 'deploy', ok: true })
		expect(outcome.steps[2]!.reason ?? '').not.toContain('DATABASE_URL')
	})

	it('Skips the deploy when database provisioning fails (never a live-but-dead URL)', async () => {
		// Arrange
		await mkdir(join(repoDir, 'migrations'), { recursive: true })
		const dbProvisioner = {
			provision: vi.fn().mockRejectedValue(new Error('api: 503 no admin database configured')),
		}
		const deploy = createFakeDeployClient()
		const { clients } = createClients({ deploy, dbProvisioner })
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert
		expect(deploy.deployments).toEqual([])
		expect(outcome.steps[2]).toMatchObject({ step: 'deploy', ok: false })
		expect(outcome.steps[2]!.reason).toContain('database provisioning failed')
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
		// No bucket → the S3 bundle is dry-run logged too (fully offline)
		const clients = createLiveDeliveryClients({ dryRun: true, log: line => lines.push(line) })
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert
		expect(outcome.ok).toBe(true)
		expect(outcome.steps.every(step => step.dryRun)).toBe(true)
		expect(clients.artifacts.kind).toBe('dry-run')
		expect(lines).toEqual(
			expect.arrayContaining([
				'[dry-run] github: create private repo mjukvaruhuset/gym-booking',
				'[dry-run] github: push main → https://github.com/mjukvaruhuset/gym-booking.git',
				'[dry-run] github: add octocat as admin on mjukvaruhuset/gym-booking',
				'[dry-run] ecs express: build image + create service mf-11111111-gym-booking from https://github.com/mjukvaruhuset/gym-booking#main',
				expect.stringMatching(
					/^\[dry-run\] s3: put s3:\/\/mf-artifacts-dry-run\/deliverables\/.*\/repo\.zip \(application\/zip, \d+ bytes\)$/
				),
			])
		)
		expect(outcome.deliverable?.deployUrl).toBe(
			'https://mf-11111111-gym-booking.eu-north-1.on.aws'
		)
	})

	it('Dry run with a bucket uploads the S3 bundle for real (our bucket, no external account)', () => {
		const clients = createLiveDeliveryClients({ dryRun: true, artifactsBucket: 'mf-artifacts-dev' })
		// GitHub and ECS Express stay faked; the artifact store is the real S3 client
		expect(clients.dryRun).toBe(true)
		expect(clients.artifacts.kind).toBe('s3')
		expect(clients.artifacts.bucket).toBe('mf-artifacts-dev')
	})

	it('Curates .github/workflows: the delivered archive drops our deploy workflows for a clean CI', async () => {
		// Arrange — seed + commit the template's workflows (our CI + two OIDC deploy workflows)
		const wf = join(repoDir, '.github', 'workflows')
		await mkdir(wf, { recursive: true })
		await writeFile(join(wf, 'ci.yml'), 'name: CI\njobs: { verify: { steps: [{ run: cdk synth }] } }\n')
		await writeFile(join(wf, 'deploy.yml'), 'name: Deploy\npermissions: { id-token: write }\n')
		await writeFile(join(wf, 'deploy-environment.yml'), 'name: Deploy env\n')
		const run = (args: string[]) => exec('git', args, { cwd: repoDir, env: gitEnv })
		await run(['add', '-A'])
		await run(['commit', '-q', '-m', 'chore: template workflows'])
		const { clients } = createClients()
		const input = createInput(repoDir)

		// Act
		const outcome = await deliver(input, clients)

		// Assert — delivery succeeded and the pushed/archived `main` tree is curated
		expect(outcome.ok).toBe(true)
		const tree = await exec('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd: repoDir })
		const workflows = tree.stdout
			.split('\n')
			.filter(name => name.startsWith('.github/workflows/'))
		expect(workflows).toEqual(['.github/workflows/ci.yml'])

		// The one workflow that ships is the clean lint+test CI — no deploy, no OIDC, no CDK
		const ci = await exec('git', ['show', 'main:.github/workflows/ci.yml'], { cwd: repoDir })
		expect(ci.stdout).toContain('name: CI')
		expect(ci.stdout).toContain('npm run lint')
		expect(ci.stdout).toContain('npm test')
		expect(ci.stdout).not.toMatch(/id-token|cdk synth|role-to-assume/i)

		// The curation was logged
		expect(input.events.find(event => event.type === 'log')?.payload.message).toMatch(
			/curated \.github\/workflows: removed .*deploy\.yml.*; wrote \.github\/workflows\/ci\.yml/
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
		expect(outcome.reason).toBe('github: GITHUB_APP (id/key/installation) is not configured (TODO-EXTERNAL)')
	})
})
