import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { exec, git } from '@mf/harness'

const gitIdentity = {
	GIT_AUTHOR_NAME: 'Mjukvaruhuset build',
	GIT_AUTHOR_EMAIL: 'build@mjukvaruhuset.se',
	GIT_COMMITTER_NAME: 'Mjukvaruhuset build',
	GIT_COMMITTER_EMAIL: 'build@mjukvaruhuset.se',
}

/** The template sits inside our monorepo and inherits its .gitignore — the customer repo needs its own */
const defaultGitignore = `node_modules
dist
dist-ssr
coverage
cdk.out
*.log
*.local
.env
.env.*
!.env.example
!apps/app/.env*
.DS_Store
`

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false
	)

const escapeHtml = (text: string) =>
	text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Every customer build seeds from the golden template's literal `<title>Template</title>` /
 * `Monorepo web template` description (`templates/web`, never edited in place per CLAUDE.md).
 * Left untouched, the delivered SPA ships that placeholder verbatim (seen: the guestbook dogfood
 * delivery, TOKENS.md 2026-08-30). Replaced here, deterministically, with the spec's actual app
 * name — a no-op if `apps/app/index.html` is missing (fake templates in tests) or has no
 * recognisable `<title>`/description to replace.
 */
const applyAppTitle = async (repoDir: string, appName: string) => {
	const indexPath = join(repoDir, 'apps', 'app', 'index.html')
	if (!(await exists(indexPath))) return
	const escaped = escapeHtml(appName)
	const html = await readFile(indexPath, 'utf8')
	const titled = html
		.replace(/<title>[^<]*<\/title>/, () => `<title>${escaped}</title>`)
		.replace(
			/(<meta name="description" content=")[^"]*(" \/>)/,
			(_m, open, close) => `${open}${escaped}${close}`
		)
	await writeFile(indexPath, titled)
}

/**
 * Seeds `<workDir>/repo` from the baked-in golden template: copy (node_modules included when
 * the image pre-installed them), rewrite the SPA's `<title>`/description with the spec's app name
 * when given one, `git init -b main`, one initial commit, and `npm i` only if the template ships
 * without node_modules. Nothing customer-specific is baked into the image — the spec arrives via
 * Postgres at runtime.
 */
export const seedRepo = async (
	templateDir: string,
	workDir: string,
	jobId: string,
	appName?: string
) => {
	const repoDir = join(workDir, 'repo')
	const gitDir = join(templateDir, '.git')
	// Clear the contents, not the dir itself: in the container `/work` is a node-owned dir whose
	// parent is root-owned, so removing it would fail (EACCES) even though writing into it works.
	await mkdir(workDir, { recursive: true })
	for (const entry of await readdir(workDir)) {
		await rm(join(workDir, entry), { recursive: true, force: true })
	}
	await cp(templateDir, repoDir, {
		recursive: true,
		// Keep workspace symlinks (node_modules/@template/* -> ../../packages/*) relative; the
		// default rewrites them to absolute paths into the immutable template
		verbatimSymlinks: true,
		// Skip only a nested .git directory — not .gitignore and friends
		filter: source => source !== gitDir && !source.startsWith(`${gitDir}/`),
	})

	if (!(await exists(join(repoDir, '.gitignore')))) {
		await writeFile(join(repoDir, '.gitignore'), defaultGitignore)
	}
	if (appName) await applyAppTitle(repoDir, appName)

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
