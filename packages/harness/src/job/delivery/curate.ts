import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The CI workflow the delivered customer repo ships. Lint + test + build on every push/PR to
 * `main` — no deploy, no OIDC, no reference to Mjukvaruhuset's AWS account. It drives the repo's
 * own npm scripts, so it works for any app the factory generates from the template.
 *
 * Why replace rather than keep the template's workflows: the built repo is instantiated from
 * `templates/web`, which ships OUR `deploy.yml` / `deploy-environment.yml` (OIDC into the
 * Mjukvaruhuset account) plus a CI that also runs `cdk synth`. Handing those to a customer would
 * (a) leak our deploy topology and (b) fail for them (no role, no bootstrap). Delivery strips the
 * whole `.github/workflows` directory and writes this single clean workflow in its place, so our
 * OIDC deploy topology never ships. (Pushing this CI is itself a workflow, so the GitHub App keeps
 * its `workflows` permission — but it now only pushes a lint+test CI, not our deploy.)
 */
export const customerCiWorkflow = `name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    name: Lint, test, build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm

      - name: Install
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Test
        run: npm test

      - name: Build
        run: npm run build
`

/**
 * Internal git-recovery leftovers a build can strand in the worktree (`.git-broken`, `.git.bak`,
 * `.git.orig`, `.git-rewrite`, …). They are ordinary directories — not the special `.git` — so the
 * delivery's `git add -A` would otherwise commit them into the customer repo (seen: job 486113ca
 * shipped `.git-broken/` + `.git.bak/`, ~4.7 MB of internal git objects). The `[.-]` after `.git`
 * matches only these artifacts, never `.github` / `.gitignore` / `.gitattributes` (whose next char
 * is a letter). Never matches the real `.git` itself.
 */
const isGitArtifactDir = (name: string) => /^\.git[.-]/.test(name)

/**
 * Removes stranded internal git-recovery directories from the repo root before the delivery
 * commit, so they never reach the pushed repo or `repo.zip`. Returns the names removed (sorted).
 */
export const stripInternalGitArtifacts = async (repoDir: string): Promise<string[]> => {
	const entries = await readdir(repoDir, { withFileTypes: true })
	const removed: string[] = []
	for (const entry of entries) {
		if (entry.isDirectory() && isGitArtifactDir(entry.name)) {
			await rm(join(repoDir, entry.name), { recursive: true, force: true })
			removed.push(entry.name)
		}
	}
	return removed.sort()
}

/** Files under `.github/workflows` are GitHub Actions definitions iff they end in `.yml` / `.yaml` */
const isWorkflowFile = (name: string) => name.endsWith('.yml') || name.endsWith('.yaml')

/** What `curateWorkflows` did, for logging / assertions */
export type CurateOutcome = {
	/** Workflow files removed from `.github/workflows`, relative to that directory, sorted */
	removed: string[]
	/** The workflow file written in their place, relative to the repo root */
	wrote: string
}

/**
 * Replaces the delivered repo's `.github/workflows` with a single customer-appropriate CI:
 * strips every existing workflow (`.yml` / `.yaml`) — deploy workflows included — and writes
 * `ci.yml` (`customerCiWorkflow`). Idempotent, and creates the directory when the repo had none.
 * Run before the docs commit so the curated workflows land in the pushed repo and in `repo.zip`.
 * Only touches `.github/workflows`; any other GitHub config (issue templates, CODEOWNERS) is left
 * as is.
 */
export const curateWorkflows = async (repoDir: string): Promise<CurateOutcome> => {
	const workflowsDir = join(repoDir, '.github', 'workflows')
	await mkdir(workflowsDir, { recursive: true })
	const entries = await readdir(workflowsDir, { withFileTypes: true })
	const removed: string[] = []
	for (const entry of entries) {
		if (entry.isFile() && isWorkflowFile(entry.name)) {
			await rm(join(workflowsDir, entry.name), { force: true })
			removed.push(entry.name)
		}
	}
	await writeFile(join(workflowsDir, 'ci.yml'), customerCiWorkflow)
	return { removed: removed.sort(), wrote: '.github/workflows/ci.yml' }
}
