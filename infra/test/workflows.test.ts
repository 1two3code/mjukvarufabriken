import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

/**
 * Assertions on the GitHub Actions workflows themselves (audit 2026-08-31, P1-8 and P0-5).
 *
 * They live under `infra/test` because that is the only suite in this repo that already runs
 * against repository files rather than a workspace's source (see ensure-bootstrapped.test.ts) —
 * and because the workflows are deployment surface, which is what `infra` owns.
 *
 * Parsing is deliberately line-based: `infra` has no YAML dependency, and the properties asserted
 * here (a top-level block, a step order) are all structural enough to read off the raw text.
 */
const workflowsDir = path.join(import.meta.dirname, '../../.github/workflows')
const read = (file: string) => readFileSync(path.join(workflowsDir, file), 'utf8')

/**
 * The entries of the workflow's TOP-LEVEL `permissions:` block, or undefined when there is none.
 * Top level == the key starts at column 0; a job-level block is indented.
 */
const topLevelPermissions = (yaml: string): Record<string, string> | undefined => {
	const lines = yaml.split('\n')
	const start = lines.findIndex(line => /^permissions:/.test(line))
	if (start === -1) return undefined
	// `permissions: read-all` / `permissions: {}` on one line
	const inline = lines[start]!.slice('permissions:'.length).trim()
	if (inline) return { '': inline }
	const entries: Record<string, string> = {}
	for (const line of lines.slice(start + 1)) {
		if (/^\s*(#.*)?$/.test(line)) continue // blank or comment
		const match = /^\s+([\w-]+):\s*(\S+)\s*$/.exec(line)
		if (!match) break // dedented to the next top-level key
		entries[match[1]!] = match[2]!
	}
	return entries
}

describe('GitHub Actions workflows', () => {
	const workflows = readdirSync(workflowsDir).filter(file => file.endsWith('.yml'))

	it('finds the workflows', () => {
		assert.ok(workflows.includes('ci.yml'))
		assert.ok(workflows.includes('deploy.yml'))
		assert.ok(workflows.includes('deploy-environment.yml'))
	})

	// P1-8. ci.yml runs on `pull_request`, checks out PR-head code and then executes it (seven
	// `npm ci` runs with lifecycle scripts enabled, `docker build` on two Dockerfiles). Without an
	// explicit block the GITHUB_TOKEN takes the repo/org default scope. Nothing in ci.yml needs
	// write — upload-artifact uses the runtime token, not GITHUB_TOKEN.
	it('gives ci.yml a read-only GITHUB_TOKEN', () => {
		const permissions = topLevelPermissions(read('ci.yml'))
		assert.ok(permissions, 'ci.yml must declare a top-level `permissions:` block')
		assert.equal(permissions['contents'], 'read')
		for (const [scope, value] of Object.entries(permissions)) {
			assert.ok(
				value === 'read' || value === 'none',
				`ci.yml must not grant \`${scope}: ${value}\` — it executes PR-head code`
			)
		}
	})

	it('declares no job-level permissions escalation in ci.yml', () => {
		const occurrences = read('ci.yml')
			.split('\n')
			.filter(line => /^\s*permissions:/.test(line))
		assert.equal(occurrences.length, 1, 'exactly one permissions block, at the top level')
	})

	// deploy.yml keeps the OIDC token it needs and nothing else; the reusable deploy-environment.yml
	// inherits the caller's permissions, so this is the only place the deploy scope is set.
	it('keeps deploy.yml to id-token + contents:read', () => {
		const permissions = topLevelPermissions(read('deploy.yml'))
		assert.ok(permissions, 'deploy.yml must declare a top-level `permissions:` block')
		assert.deepEqual(permissions, { 'id-token': 'write', contents: 'read' })
	})

	// P0-5: the guard `infra/scripts/deploy.sh` has run since the 2026-08-30 hardening audit was
	// missing from the other path that can deploy live. It must fail before the SPA build, and long
	// before `cdk deploy mf-live` creates a plain-HTTP ALB listener.
	it('runs the live domain guard before the web-stack deploy in deploy-environment.yml', () => {
		const yaml = read('deploy-environment.yml')
		const guard = yaml.indexOf('scripts/check-live-domain.ts')
		assert.notEqual(guard, -1, 'deploy-environment.yml must run scripts/check-live-domain.ts')
		assert.ok(
			guard < yaml.indexOf('npm run build'),
			'the guard must fail before the SPA build, not after it'
		)
		for (const stack of ['resources-', 'mf-', 'ops-', 'budget-']) {
			assert.ok(
				guard < yaml.indexOf(`cdk deploy ${stack}`),
				`the guard must run before \`cdk deploy ${stack}\``
			)
		}
	})
})
