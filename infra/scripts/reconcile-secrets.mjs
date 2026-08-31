#!/usr/bin/env node
// Preflight for deploy.sh: restores any of resources-<env>'s six placeholder secrets that are
// currently scheduled for deletion, so a retry after a rolled-back resources-<env> create doesn't
// immediately fail with "already scheduled for deletion" on every one of them (hardening audit
// 2026-08-30, finding F2). All six use the same DESTROY removal policy outside live, and
// CloudFormation's default secret deletion (no ForceDeleteWithoutRecovery) schedules a ~30-day
// recovery window rather than deleting immediately — so this is reachable on dev/qa today, not
// just a future live concern.
//
// RestoreSecret is non-destructive: it only un-schedules a pending deletion, it never touches (or
// even reads) the secret's value.
//
//   node infra/scripts/reconcile-secrets.mjs <env>

/* global process, console */
import { execFileSync } from 'node:child_process'

// Mirrors ExternalSecretName in infra/lib/resources-stack.ts.
const SECRET_NAMES = [
	'anthropic-api-key',
	'auth-jwt-private-key',
	'github-app-key',
	'github-oauth-client-secret',
	'sentry-dsn',
	'stripe-secret-key',
	'stripe-webhook-secret',
]

const env = process.argv[2]
if (!env) {
	console.error('reconcile-secrets: usage: reconcile-secrets.mjs <env>')
	process.exit(1)
}

const sh = cmdArgs => execFileSync('aws', [...cmdArgs, '--output', 'json'], { encoding: 'utf8' }).trim()

for (const name of SECRET_NAMES) {
	const secretId = `mf/${env}/${name}`
	let described
	try {
		described = JSON.parse(sh(['secretsmanager', 'describe-secret', '--secret-id', secretId]))
	} catch {
		continue // doesn't exist yet (first deploy) — nothing to reconcile, cdk deploy will create it
	}
	if (described.DeletedDate) {
		sh(['secretsmanager', 'restore-secret', '--secret-id', secretId])
		console.log(`reconcile-secrets: restored ${secretId} (was scheduled for deletion)`)
	}
}
