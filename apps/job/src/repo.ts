import { cp, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { exec, git } from '@mf/harness'

const gitIdentity = {
	GIT_AUTHOR_NAME: 'Mjukvaruhuset build',
	GIT_AUTHOR_EMAIL: 'build@mjukvaruhuset.se',
	GIT_COMMITTER_NAME: 'Mjukvaruhuset build',
	GIT_COMMITTER_EMAIL: 'build@mjukvaruhuset.se',
}

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false
	)

/**
 * Seeds `<workDir>/repo` from the baked-in golden template: copy (node_modules included when
 * the image pre-installed them), `git init -b main`, one initial commit, and `npm i` only if
 * the template ships without node_modules. Nothing customer-specific is baked into the image —
 * the spec arrives via Postgres at runtime.
 */
export const seedRepo = async (templateDir: string, workDir: string, jobId: string) => {
	const repoDir = join(workDir, 'repo')
	await rm(workDir, { recursive: true, force: true })
	await mkdir(workDir, { recursive: true })
	await cp(templateDir, repoDir, {
		recursive: true,
		filter: source => !source.includes(`${templateDir}/.git`),
	})

	const env = gitIdentity
	await git(['init', '-q', '-b', 'main'], { cwd: repoDir, env })
	await git(['config', 'core.hooksPath', '/dev/null'], { cwd: repoDir, env })
	await git(['add', '-A'], { cwd: repoDir, env })
	await git(['commit', '-q', '-m', `chore: seed from template for job ${jobId}`], {
		cwd: repoDir,
		env,
	})

	if (!(await exists(join(repoDir, 'node_modules')))) {
		const install = await exec('npm', ['i', '--no-audit', '--no-fund', '--ignore-scripts'], {
			cwd: repoDir,
			timeoutMs: 10 * 60_000,
		})
		if (install.code !== 0) throw new Error(`npm i in seeded repo failed:\n${install.stderr}`)
	}
	return repoDir
}

export { gitIdentity }
