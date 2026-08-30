import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	readlink,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises'
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

	it('Rewrites apps/app/index.html title + description with the given app name', async () => {
		// Arrange: a template shaped like the golden one's apps/app/index.html
		const template = join(root, 'template')
		await mkdir(join(template, 'apps', 'app'), { recursive: true })
		await writeFile(join(template, 'package.json'), '{"name":"t"}')
		await writeFile(
			join(template, 'apps', 'app', 'index.html'),
			'<!doctype html>\n<html>\n<head>\n<title>Template</title>\n' +
				'<meta name="description" content="Monorepo web template" />\n</head>\n<body></body>\n</html>\n'
		)
		const workDir = join(root, 'work')

		// Act
		const repoDir = await seedRepo(template, workDir, 'job-title', 'Kringlan Bageri & Café')

		// Assert: title + description carry the (HTML-escaped) app name, nothing else changed
		const html = await readFile(join(repoDir, 'apps', 'app', 'index.html'), 'utf8')
		expect(html).toContain('<title>Kringlan Bageri &amp; Café</title>')
		expect(html).toContain('<meta name="description" content="Kringlan Bageri &amp; Café" />')
	})

	it('Treats $-sequences in the app name as literal text, not replacement patterns', async () => {
		// Arrange: an app name containing $$, $1, $2 — all special to String.replace's
		// string-replacement form (which the fix must not use), and $1/$2 double as this
		// description regex's own capture-group indices, the sharpest failure mode
		const template = join(root, 'template')
		await mkdir(join(template, 'apps', 'app'), { recursive: true })
		await writeFile(join(template, 'package.json'), '{"name":"t"}')
		await writeFile(
			join(template, 'apps', 'app', 'index.html'),
			'<!doctype html>\n<html>\n<head>\n<title>Template</title>\n' +
				'<meta name="description" content="Monorepo web template" />\n</head>\n<body></body>\n</html>\n'
		)
		const workDir = join(root, 'work')
		const appName = 'A $5 footlong $$ $1 $2 tracker'

		// Act
		const repoDir = await seedRepo(template, workDir, 'job-dollar', appName)

		// Assert: the literal app name lands verbatim, untouched by $-substitution
		const html = await readFile(join(repoDir, 'apps', 'app', 'index.html'), 'utf8')
		expect(html).toContain(`<title>${appName}</title>`)
		expect(html).toContain(`<meta name="description" content="${appName}" />`)
	})

	it('Leaves the seed untouched when no app name is given, or apps/app/index.html is absent', async () => {
		// Arrange: no apps/app dir at all (the other fixture templates in this file)
		const template = join(root, 'template')
		await mkdir(template, { recursive: true })
		await writeFile(join(template, 'package.json'), '{"name":"t"}')
		const workDir = join(root, 'work')

		// Act + Assert: does not throw, whether or not an app name is passed
		await expect(seedRepo(template, workDir, 'job-no-title')).resolves.toBeTruthy()
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
