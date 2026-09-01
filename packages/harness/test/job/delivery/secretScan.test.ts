import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanDeliveredFiles, scanRepoForSecrets, secretScanReason } from '#job/delivery/secretScan.ts'
import { exec } from '#job/exec.ts'

const gitEnv = {
	GIT_AUTHOR_NAME: 't',
	GIT_AUTHOR_EMAIL: 't@t',
	GIT_COMMITTER_NAME: 't',
	GIT_COMMITTER_EMAIL: 't@t',
}

// Test fixtures only — shaped like real credentials, none of them live.
// Assembled at runtime rather than written as literals: a complete credential-shaped string in
// this file trips GitHub's own push protection (it rejected this branch once — GH013, "Stripe API
// Key"), which would make the scanner's tests unpushable. The runtime values are unchanged, so
// the scanner is exercised exactly as before.
const filler = (length: number) => 'A'.repeat(length)
const fakeAnthropicKey = `sk-ant-${'api03'}-${filler(24)}`
const fakeGithubToken = `${'ghp'}_${filler(36)}`
const fakeStripeKey = `${'sk'}_${'live'}_${filler(24)}`

describe('scanRepoForSecrets', () => {
	let root: string
	let repoDir: string

	const git = (args: string[]) => exec('git', args, { cwd: repoDir, env: gitEnv })
	const commit = async (message: string) => {
		await git(['add', '-A'])
		await git(['commit', '-q', '-m', message])
	}

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mf-secretscan-'))
		repoDir = join(root, 'repo')
		await mkdir(repoDir, { recursive: true })
		await git(['init', '-q', '-b', 'main'])
		await writeFile(join(repoDir, 'README.md'), '# App\n\nA clean readme.\n')
		await writeFile(
			join(repoDir, 'src.ts'),
			'export const config = { url: process.env.API_URL }\n'
		)
		await commit('chore: seed')
	})
	afterEach(() => rm(root, { recursive: true, force: true }))

	it('Passes a clean tree', async () => {
		const report = await scanRepoForSecrets(repoDir)

		expect(report.ok).toBe(true)
		expect(report.hits).toEqual([])
		expect(report.filesScanned).toBe(2)
	})

	it('Finds Anthropic / GitHub / AWS / Stripe shaped tokens with file:line, never the value', async () => {
		// Arrange — one leak per provider class, in different files
		await writeFile(join(repoDir, '.env.example'), `ANTHROPIC_API_KEY=${fakeAnthropicKey}\n`)
		await writeFile(join(repoDir, 'notes.md'), `Use ${fakeGithubToken} to push.\n`)
		await writeFile(
			join(repoDir, 'deploy.sh'),
			'#!/bin/sh\nexport AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n'
		)
		await writeFile(join(repoDir, 'stripe.ts'), `const key = '${fakeStripeKey}'\n`)
		await writeFile(
			join(repoDir, 'key.pem'),
			'-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n'
		)
		await commit('feat: leaks')

		// Act
		const report = await scanRepoForSecrets(repoDir)

		// Assert
		expect(report.ok).toBe(false)
		const byPattern = Object.fromEntries(report.hits.map(hit => [hit.pattern, hit.location]))
		expect(byPattern['anthropic-api-key']).toBe('.env.example:1')
		expect(byPattern['github-token']).toBe('notes.md:1')
		expect(byPattern['aws-access-key-id']).toBe('deploy.sh:2')
		expect(byPattern['stripe-secret-key']).toBe('stripe.ts:1')
		expect(byPattern['private-key-block']).toBe('key.pem:1')
		// Redacted: the report never carries the matched text
		expect(JSON.stringify(report)).not.toContain(fakeAnthropicKey)
		expect(JSON.stringify(report)).not.toContain(fakeGithubToken)
	})

	it("Finds the job's own known secret values, including a PEM matched per line", async () => {
		const pem = `-----BEGIN PRIVATE KEY-----\nMIIEvBBBBBBBBBBBBBBBBBBBBBBBBBBB\nQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ\n-----END PRIVATE KEY-----`
		// The worker wrote one body line of the key into a config — re-wrapped, no armor lines
		await writeFile(
			join(repoDir, 'config.ts'),
			`const x = 'MIIEvBBBBBBBBBBBBBBBBBBBBBBBBBBB'\n`
		)
		await writeFile(join(repoDir, 'token.txt'), 'per-job-report-token-value-123\n')
		await commit('feat: sneaky')

		const report = await scanRepoForSecrets(repoDir, {
			knownSecrets: [pem, 'per-job-report-token-value-123'],
		})

		expect(report.ok).toBe(false)
		expect(report.hits).toEqual(
			expect.arrayContaining([
				{ location: 'config.ts:1', pattern: 'known-secret-value' },
				{ location: 'token.txt:1', pattern: 'known-secret-value' },
			])
		)
	})

	it('Finds a secret that was committed and then removed — it still leaves in the history', async () => {
		await writeFile(join(repoDir, 'oops.ts'), `const key = '${fakeAnthropicKey}'\n`)
		await commit('feat: oops')
		await writeFile(join(repoDir, 'oops.ts'), `const key = process.env.ANTHROPIC_API_KEY\n`)
		await commit('fix: remove the key')

		const report = await scanRepoForSecrets(repoDir)

		// One history hit: the old blob is still reachable and leaves with the pushed history
		expect(report.ok).toBe(false)
		expect(report.hits).toHaveLength(1)
		expect(report.hits[0]!.location).toMatch(/^history:[0-9a-f]{12}:oops\.ts$/)
		expect(report.hits[0]!.pattern).toBe('anthropic-api-key')
	})

	it('Ignores untracked files — node_modules fixtures with dummy keys never brick a delivery', async () => {
		await mkdir(join(repoDir, 'node_modules/dep'), { recursive: true })
		await writeFile(join(repoDir, 'node_modules/dep/fixture.pem'), '-----BEGIN PRIVATE KEY-----\n')
		await writeFile(join(repoDir, 'untracked.txt'), fakeAnthropicKey)

		const report = await scanRepoForSecrets(repoDir)

		expect(report.ok).toBe(true)
	})

	it('Finds a secret hidden in a tracked binary file — NUL bytes do not skip the scan', async () => {
		// The evasion from the adversarial review: printf '\0\n%s' "$SECRET" > x.bin — tracked,
		// delivered by push + repo.zip, previously invisible to both the tree and history scans
		await writeFile(
			join(repoDir, 'blob.bin'),
			Buffer.concat([Buffer.alloc(16), Buffer.from(`\n${fakeStripeKey}`)])
		)
		await git(['add', 'blob.bin'])
		await git(['commit', '-q', '-m', 'chore: binary'])

		const report = await scanRepoForSecrets(repoDir)

		expect(report.ok).toBe(false)
		expect(report.hits).toEqual([{ location: 'blob.bin:2', pattern: 'stripe-secret-key' }])
	})

	it('Finds a known secret value in a tracked binary blob that only exists in history', async () => {
		await writeFile(
			join(repoDir, 'asset.png'),
			Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]), Buffer.from('per-job-report-token-value-123')])
		)
		await commit('feat: asset')
		await git(['rm', '-q', 'asset.png'])
		await git(['commit', '-q', '-m', 'chore: remove asset'])

		const report = await scanRepoForSecrets(repoDir, {
			knownSecrets: ['per-job-report-token-value-123'],
		})

		expect(report.ok).toBe(false)
		expect(report.hits).toEqual([
			{
				location: expect.stringMatching(/^history:[0-9a-f]{12}:asset\.png$/),
				pattern: 'known-secret-value',
			},
		])
	})

	it('Finds a secret introduced only by a merge commit (evil merge) — git log -p never shows it', async () => {
		await git(['checkout', '-q', '-b', 'feature'])
		await writeFile(join(repoDir, 'feature.ts'), 'export const feature = true\n')
		await commit('feat: feature')
		await git(['checkout', '-q', 'main'])
		await writeFile(join(repoDir, 'main.ts'), 'export const main = true\n')
		await commit('feat: main')
		// The merge commit's tree gains a file neither parent had — a default `git log -p` prints
		// no patch at all for merge commits, so a patch-based history scan is blind here
		await git(['merge', '--no-commit', '--no-ff', 'feature'])
		await writeFile(join(repoDir, 'sneaky.ts'), `const key = '${fakeGithubToken}'\n`)
		await git(['add', '-A'])
		await git(['commit', '-q', '-m', 'merge: feature'])
		// Then remove it again so it survives only in the merge commit's tree
		await git(['rm', '-q', 'sneaky.ts'])
		await git(['commit', '-q', '-m', 'chore: cleanup'])

		const report = await scanRepoForSecrets(repoDir)

		expect(report.ok).toBe(false)
		expect(report.hits).toEqual([
			{
				location: expect.stringMatching(/^history:[0-9a-f]{12}:sneaky\.ts$/),
				pattern: 'github-token',
			},
		])
	})

	it('Short or empty known secrets are ignored (no scanning for "" or "test")', async () => {
		const report = await scanRepoForSecrets(repoDir, { knownSecrets: ['', 'test', 'a'] })

		expect(report.ok).toBe(true)
	})

	it('scanDeliveredFiles catches secrets in untracked build output, binaries included', () => {
		const clean = scanDeliveredFiles([
			{ name: 'index.html', content: Buffer.from('<html></html>') },
			{ name: 'assets/a.js', content: Buffer.from('export const x = 1') },
		])
		expect(clean.ok).toBe(true)
		expect(clean.filesScanned).toBe(2)

		const report = scanDeliveredFiles(
			[
				{ name: 'assets/config.js', content: Buffer.from(`const key = '${fakeStripeKey}'`) },
				{
					name: 'assets/x.bin',
					content: Buffer.concat([Buffer.alloc(8), Buffer.from('\nper-job-report-token-value-123')]),
				},
			],
			['per-job-report-token-value-123']
		)
		expect(report.ok).toBe(false)
		expect(report.hits).toEqual([
			{ location: 'assets/config.js:1', pattern: 'stripe-secret-key' },
			{ location: 'assets/x.bin:2', pattern: 'known-secret-value' },
		])
		expect(JSON.stringify(report)).not.toContain(fakeStripeKey)
	})

	it('secretScanReason names locations and patterns, caps the list at 10', () => {
		const hits = Array.from({ length: 12 }, (_, index) => ({
			location: `file${index}.ts:1`,
			pattern: 'anthropic-api-key',
		}))
		const reason = secretScanReason({ ok: false, filesScanned: 12, hits })

		expect(reason).toContain('12 credential-shaped string(s)')
		expect(reason).toContain('file0.ts:1 (anthropic-api-key)')
		expect(reason).toContain('+2 more')
		expect(reason).not.toContain('file11.ts')
	})
})
