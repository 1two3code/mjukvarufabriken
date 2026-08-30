#!/usr/bin/env node
/* global process, console */
// Provision a fresh platform member ACCOUNT for a env (Phoenix primitives P1–P3). See docs/PHOENIX.md.
// Run as the Organizations MANAGEMENT account. Idempotent, DRY-RUN BY DEFAULT (--apply to change).
//
//   node infra/scripts/provision-account.mjs qa [--region eu-north-1] [--apply]
//
//   P1  CreateAccount `mf-<env>` (root email aws+<env>@mjukvaruhuset.se, RoleName
//       OrganizationAccountAccessRole) — reused if it already exists.
//   P2  assume OrganizationAccountAccessRole in the new account; `cdk bootstrap` eu-north-1 + us-east-1.
//   P3  `cdk deploy github-deploy` (the OIDC provider + mf-github-deploy role) into the new account.
//
// Prints the account id + the mf-github-deploy role ARN, ready for:
//   node infra/scripts/provision-env.mjs <env> --account <id> --deploy-role-arn <arn> ...

import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const EMAIL_DOMAIN = 'mjukvaruhuset.se'
const ACCESS_ROLE = 'OrganizationAccountAccessRole'
const INFRA_DIR = dirname(dirname(fileURLToPath(import.meta.url))) // infra/

const args = process.argv.slice(2)
const env = args[0]
const flag = name => {
	const i = args.indexOf(`--${name}`)
	return i >= 0 ? args[i + 1] : undefined
}
const APPLY = args.includes('--apply')
const region = flag('region') || 'eu-north-1'

const fail = m => (console.error(`provision-account: ${m}`), process.exit(1))
if (!env || !['qa', 'live'].includes(env)) fail('first arg must be `qa` or `live`')

const log = (...m) => console.log(...m)
const plan = m => log(`  ${APPLY ? 'APPLY' : 'PLAN '} ${m}`)
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { encoding: 'utf8', ...opts }).trim()
const awsJson = a => JSON.parse(sh('aws', [...a, '--output', 'json']) || 'null')

const accountName = `mf-${env}`
const rootEmail = `aws+${env}@${EMAIL_DOMAIN}`

// MARK: guard — must be the org management account
const org = awsJson(['organizations', 'describe-organization'])
const mgmt = org?.Organization?.MasterAccountId
const caller = awsJson(['sts', 'get-caller-identity']).Account
if (!mgmt) fail('no AWS Organization found for these credentials')
if (caller !== mgmt) fail(`caller ${caller} is not the org management account ${mgmt} — P1–P3 must run there`)
log(`✓ org management account ${mgmt} (org ${org.Organization.Id})`)

// MARK: P1 — CreateAccount (idempotent)
log(`\n[P1] account ${accountName} <${rootEmail}>`)
const accounts = awsJson(['organizations', 'list-accounts']).Accounts || []
let account = accounts.find(a => a.Name === accountName || a.Email === rootEmail)
let accountId
if (account) {
	accountId = account.Id
	log(`  exists: ${accountId} (status ${account.Status})`)
	if (account.Status !== 'ACTIVE') fail(`account ${accountId} is ${account.Status}, not ACTIVE`)
} else if (APPLY) {
	const created = awsJson(['organizations', 'create-account', '--account-name', accountName, '--email', rootEmail, '--role-name', ACCESS_ROLE])
	const reqId = created.CreateAccountStatus?.Id
	log(`  CreateAccount requested (${reqId}); polling…`)
	const deadline = Date.now() + 5 * 60 * 1000
	for (;;) {
		const st = awsJson(['organizations', 'describe-create-account-status', '--create-account-request-id', reqId]).CreateAccountStatus
		if (st.State === 'SUCCEEDED') { accountId = st.AccountId; break }
		if (st.State === 'FAILED') fail(`CreateAccount failed: ${st.FailureReason}`)
		if (Date.now() > deadline) fail('CreateAccount did not finish in 5 min')
		execFileSync('sleep', ['5'])
	}
	log(`  created: ${accountId}`)
} else {
	plan(`aws organizations create-account --account-name ${accountName} --email ${rootEmail} --role-name ${ACCESS_ROLE}`)
	accountId = '<new-account-id>'
}

const deployRoleArn = `arn:aws:iam::${accountId}:role/mf-github-deploy`

// MARK: assume OrganizationAccountAccessRole into the new account (for P2/P3)
let childEnv = process.env
if (APPLY && accountId !== '<new-account-id>') {
	const creds = awsJson(['sts', 'assume-role', '--role-arn', `arn:aws:iam::${accountId}:role/${ACCESS_ROLE}`, '--role-session-name', 'mf-provision']).Credentials
	childEnv = {
		...process.env,
		AWS_ACCESS_KEY_ID: creds.AccessKeyId,
		AWS_SECRET_ACCESS_KEY: creds.SecretAccessKey,
		AWS_SESSION_TOKEN: creds.SessionToken,
		AWS_PROFILE: '',
		CDK_DEFAULT_ACCOUNT: accountId,
		CDK_DEFAULT_REGION: region,
	}
}
const cdk = a => (APPLY ? log(sh('npx', ['cdk', ...a], { cwd: INFRA_DIR, env: childEnv })) : plan(`(in ${accountId}) npx cdk ${a.join(' ')}`))

// MARK: P2 — bootstrap both regions
log(`\n[P2] cdk bootstrap ${accountId} (eu-north-1 + us-east-1)`)
cdk(['bootstrap', `aws://${accountId}/eu-north-1`])
cdk(['bootstrap', `aws://${accountId}/us-east-1`])

// MARK: P3 — deploy github-deploy (OIDC role) into the new account
log(`\n[P3] cdk deploy github-deploy → ${accountId}`)
cdk(['deploy', 'github-deploy', '--require-approval', 'never'])

log(`\n${APPLY ? '✅ applied' : 'ℹ dry-run only — re-run with --apply'}. Next:`)
log(`  account id:      ${accountId}`)
log(`  deploy role arn: ${deployRoleArn}`)
log(`  → node infra/scripts/provision-env.mjs ${env} --account ${accountId} --deploy-role-arn ${deployRoleArn} --parent-zone-id <root-zone>`)
