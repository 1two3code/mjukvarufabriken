import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeArtifactStore } from '#job/delivery/artifacts.ts'
import { debugKeyOf, uploadDebugBundle } from '#job/delivery/bundle.ts'
import { exec } from '#job/exec.ts'

import type { GateReport } from '@mf/models'

const gitEnv = {
	GIT_AUTHOR_NAME: 't',
	GIT_AUTHOR_EMAIL: 't@t',
	GIT_COMMITTER_NAME: 't',
	GIT_COMMITTER_EMAIL: 't@t',
}

const seedRepo = async (root: string) => {
	const repoDir = join(root, 'repo')
	await mkdir(repoDir, { recursive: true })
	await writeFile(join(repoDir, 'README.md'), '# built by a failed job\n')
	const run = (args: string[]) => exec('git', args, { cwd: repoDir, env: gitEnv })
	await run(['init', '-q', '-b', 'main'])
	await run(['add', '-A'])
	await run(['commit', '-q', '-m', 'chore: seed'])
	return repoDir
}

const gates: GateReport[] = [
	{
		name: 'verify',
		ok: true,
		startedAt: '2026-08-27T10:00:00.000Z',
		durationMs: 1000,
		tokens: 0,
		summary: 'lint + test green',
	},
	{
		name: 'acceptance-check',
		ok: false,
		startedAt: '2026-08-27T10:00:01.000Z',
		durationMs: 1000,
		tokens: 10,
		summary: '1 criterion(s) not met: f0.c0 (unmet)',
		details: { report: { 'f0.c0': { evidence: [], status: 'unmet' } } },
	},
]

describe('uploadDebugBundle', () => {
	let root: string
	let repoDir: string
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mf-debug-'))
		repoDir = await seedRepo(root)
	})
	afterEach(() => rm(root, { recursive: true, force: true }))

	it('Archives main + the gate/acceptance reports under deliverables/<jobId>/debug/', async () => {
		const artifacts = createFakeArtifactStore()
		const jobId = '9999aaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

		const files = await uploadDebugBundle({ jobId, repoDir, artifacts, gates })

		const prefix = debugKeyOf(jobId)
		expect(prefix).toBe(`deliverables/${jobId}/debug/`)
		expect([...artifacts.objects.keys()].sort()).toEqual(
			[`${prefix}repo.zip`, `${prefix}gates.json`, `${prefix}acceptance.json`].sort()
		)
		expect(files.map(file => file.name)).toEqual(['repo.zip', 'gates.json', 'acceptance.json'])
		expect(artifacts.objects.get(`${prefix}repo.zip`)?.contentType).toBe('application/zip')
		// The acceptance report is lifted from the acceptance-check gate so its gates re-run offline
		expect(JSON.parse(artifacts.objects.get(`${prefix}acceptance.json`)!.body as string)).toEqual({
			'f0.c0': { evidence: [], status: 'unmet' },
		})
		expect(JSON.parse(artifacts.objects.get(`${prefix}gates.json`)!.body as string)).toHaveLength(2)
	})

	it('Falls back to an empty acceptance report when no acceptance-check gate ran', async () => {
		const artifacts = createFakeArtifactStore()
		const jobId = '1111'

		await uploadDebugBundle({ jobId, repoDir, artifacts, gates: [gates[0]!] })

		const body = artifacts.objects.get(`${debugKeyOf(jobId)}acceptance.json`)!.body as string
		expect(JSON.parse(body)).toEqual({})
	})
})
