/**
 * Replays a recorded cassette through the REAL `runJob`, entirely offline — no Anthropic, no
 * tokens, no GitHub/ECS Express/S3 (delivery runs against in-memory fakes). The cassette's two
 * seams (planner + Agent SDK `query()`) are answered from the JSONL file; the rest is the real
 * orchestrator: plan → DAG → merges → the deterministic + replayed gates → delivery.
 *
 *   npm run e2e:replay                 # replays the committed fixture (packages/harness/test/fixtures/cassette)
 *   npm run e2e:replay -- <dir>        # replays a cassette recorded by `apps/job` (MF_CASSETTE=<dir>)
 *
 * A cassette directory holds `cassette.jsonl` (the recorded seams) and `job.json`
 * ({ id?, spec, budget, delivery? }) — `apps/job` writes both when recording. Exits 0 only when
 * the replayed build delivers and the cassette is fully drained.
 */
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { JobBudgetSchema, SpecSchema } from '@mf/models'

import { createFakeDeliveryClients, createLivePorts, exec, runJob, setSessionQuery } from '#job/index.ts'
import { Cassette, replayQuery, replaySpecEngineClient } from '#testing/cassette.ts'

import type { NewJobEvent } from '@mf/models'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const defaultCassetteDir = join(repoRoot, 'packages/harness/test/fixtures/cassette')

const dir = resolve(process.argv[2] ?? defaultCassetteDir)
const templateDir = process.env.TEMPLATE_DIR || join(repoRoot, 'templates/web')

const exists = (path: string) => stat(path).then(() => true, () => false)

const gitEnv = {
	GIT_AUTHOR_NAME: 'Mjukvaruhuset build',
	GIT_AUTHOR_EMAIL: 'build@mjukvaruhuset.se',
	GIT_COMMITTER_NAME: 'Mjukvaruhuset build',
	GIT_COMMITTER_EMAIL: 'build@mjukvaruhuset.se',
}

/** Seed a throwaway repo from the golden template, node_modules hard-linked (like the offline e2e) */
const seedRepo = async () => {
	const root = await mkdtemp(join(tmpdir(), 'mf-replay-'))
	const repoDir = join(root, 'repo')
	await mkdir(repoDir, { recursive: true })
	await cp(templateDir, repoDir, {
		recursive: true,
		verbatimSymlinks: true,
		filter: source => {
			if (source === templateDir) return true
			const parts = source.slice(templateDir.length + 1).split('/')
			return parts[0] !== '.git' && !parts.includes('node_modules')
		},
	})
	await exec(
		'bash',
		['-c', `cd "${templateDir}" && find . -maxdepth 3 -name node_modules -type d | while read d; do mkdir -p "${repoDir}/$(dirname "$d")"; cp -al "$d" "${repoDir}/$d"; done`],
		{ cwd: repoDir }
	)
	if (!(await exists(join(repoDir, '.gitignore')))) {
		await writeFile(join(repoDir, '.gitignore'), 'node_modules\ndist\ncoverage\n')
	}
	const run = (args: string[]) => exec('git', args, { cwd: repoDir, env: gitEnv })
	await run(['init', '-q', '-b', 'main'])
	await run(['config', 'core.hooksPath', '/dev/null'])
	await run(['config', 'user.name', gitEnv.GIT_AUTHOR_NAME])
	await run(['config', 'user.email', gitEnv.GIT_AUTHOR_EMAIL])
	await run(['add', '-A'])
	await run(['commit', '-q', '-m', 'chore: seed from template'])
	const seedCommit = (await run(['rev-parse', 'HEAD'])).stdout.trim()
	return { root, repoDir, seedCommit }
}

const loadJob = async () => {
	const raw = JSON.parse(await readFile(join(dir, 'job.json'), 'utf8')) as Record<string, unknown>
	return {
		id: typeof raw.id === 'string' ? raw.id : '00000000-0000-0000-0000-000000000000',
		spec: SpecSchema.parse(raw.spec),
		budget: JobBudgetSchema.parse(raw.budget),
		delivery: (raw.delivery as { slug: string; appName: string } | undefined) ?? {
			slug: 'replayed',
			appName: 'Replayed build',
		},
	}
}

if (!(await exists(join(dir, 'cassette.jsonl')))) {
	console.error(`no cassette.jsonl in ${dir}`)
	process.exit(64)
}
if (!(await exists(join(dir, 'job.json')))) {
	console.error(`no job.json in ${dir} (apps/job writes it when recording)`)
	process.exit(64)
}

Object.assign(process.env, gitEnv)
const job = await loadJob()
const cassette = await Cassette.open(dir, 'replay')
setSessionQuery(replayQuery(cassette))
const delivery = createFakeDeliveryClients()
const ports = createLivePorts({ client: replaySpecEngineClient(cassette), delivery })
const { root, repoDir, seedCommit } = await seedRepo()

try {
	const outcome = await runJob(
		{ id: job.id, spec: job.spec, budget: job.budget, repoDir, seedCommit, delivery: job.delivery },
		{
			ports,
			hooks: {
				emit: async (event: NewJobEvent) => void console.log(`event ${event.type}`),
				pollIntervalMs: 1_000_000_000,
			},
		}
	)
	console.log(
		JSON.stringify(
			{
				status: outcome.status,
				reason: outcome.reason,
				tokensUsed: outcome.tokensUsed,
				gates: outcome.gates.map(gate => `${gate.name}:${gate.ok ? 'ok' : 'failed'}`),
			},
			null,
			2
		)
	)
	cassette.assertDrained()
	process.exit(outcome.status === 'delivered' ? 0 : 1)
} finally {
	await rm(root, { recursive: true, force: true })
}
