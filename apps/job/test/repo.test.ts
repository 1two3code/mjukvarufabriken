import { mkdir, mkdtemp, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { exec } from '@mf/harness'

import { seedRepo } from '#/repo.ts'

describe('seedRepo', () => {
	let root: string
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mf-seed-'))
	})
	afterEach(() => rm(root, { recursive: true, force: true }))

	it('Copies the template with workspace symlinks kept relative, initialises git and skips npm i', async () => {
		// Arrange: a template with a pre-installed node_modules workspace link + a stale .git
		const template = join(root, 'template')
		await mkdir(join(template, 'packages', 'models'), { recursive: true })
		await mkdir(join(template, 'node_modules', '@template'), { recursive: true })
		await mkdir(join(template, '.git'), { recursive: true })
		await writeFile(join(template, 'packages', 'models', 'index.ts'), 'export const x = 1\n')
		await writeFile(join(template, 'package.json'), '{"name":"t","workspaces":["packages/*"]}')
		await writeFile(join(template, '.git', 'HEAD'), 'ref: refs/heads/main\n')
		await symlink('../../packages/models', join(template, 'node_modules', '@template', 'models'))
		const workDir = join(root, 'work')

		// Act
		const repoDir = await seedRepo(template, workDir, 'job-1')

		// Assert
		expect(repoDir).toBe(join(workDir, 'repo'))
		expect(await readlink(join(repoDir, 'node_modules', '@template', 'models'))).toBe(
			'../../packages/models'
		)
		const log = await exec('git', ['log', '--oneline'], { cwd: repoDir })
		expect(log.stdout).toMatch(/seed from template for job job-1/)
		const status = await exec('git', ['status', '--porcelain'], { cwd: repoDir })
		expect(status.stdout.trim()).toBe('')
		// node_modules is ignored, so the stale template .git never became part of the seed
		const tracked = await exec('git', ['ls-files'], { cwd: repoDir })
		expect(tracked.stdout).toContain('packages/models/index.ts')
		expect(tracked.stdout).not.toContain('node_modules')
		expect(tracked.stdout).not.toMatch(/^\.git\//m)
	})

	it('Clears a stale work dir without removing the dir itself (container /work is a fixed mount)', async () => {
		// Arrange: minimal template + a work dir with leftovers from a previous run
		const template = join(root, 'template')
		await mkdir(template, { recursive: true })
		await writeFile(join(template, 'package.json'), '{"name":"t"}')
		const workDir = join(root, 'work')
		await mkdir(join(workDir, 'worktrees', 'old'), { recursive: true })
		await writeFile(join(workDir, 'stale.txt'), 'x')
		const before = (await stat(workDir)).ino

		// Act
		await seedRepo(template, workDir, 'job-2')

		// Assert: same directory inode, leftovers gone, repo seeded
		expect((await stat(workDir)).ino).toBe(before)
		expect(await readdir(workDir)).toEqual(['repo'])
	})
})
