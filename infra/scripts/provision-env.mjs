#!/usr/bin/env node
// Provision the DNS + certs + GitHub environment for a platform env (Phoenix primitive P4–P7).
// See docs/PHOENIX.md. Idempotent and DRY-RUN BY DEFAULT — pass --apply to make changes.
//
//   node infra/scripts/provision-env.mjs qa \
//     --account 111122223333 --deploy-role-arn arn:aws:iam::111122223333:role/mf-github-deploy \
//     [--assume-role] [--parent-zone-id Z0ROOT] [--region eu-north-1] [--reviewer <id>] [--apply]
//
// Auth: either authenticate to the TARGET env account yourself, OR pass `--assume-role` to run as
// your MANAGEMENT account and have the script assume `OrganizationAccountAccessRole` in --account
// for the target-account work (the same role provision-account created). Without --assume-role the
// script refuses to run if the caller's account != --account (the wrong-account footgun); with it,
// the assume proves access. `gh` is authenticated for the repo regardless.
//
// Cross-account note: the target-account calls (zone, certs) use --account's creds; the NS
// DELEGATION into --parent-zone-id keeps your ORIGINAL creds, because the root zone lives in the
// management account today — so `--assume-role` still writes the delegation. Certs validate against
// the env's own subdomain zone; without --parent-zone-id the NS records are printed to add by hand.
//
// LIMITATIONS (v1): handles a SUBDOMAIN env (qa → qa.mjukvaruhuset.se). The `live` APEX
// (mjukvaruhuset.se) needs the root zone to live in the env account — see PHOENIX.md "root-zone
// ownership" — and is refused here until that decision is wired.

/* global process, console, URL */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const ROOT_DOMAIN = 'mjukvaruhuset.se'
const REPO = '1two3code/mjukvarufabriken'

// MARK: args
const args = process.argv.slice(2)
const env = args[0]
const flag = name => {
	const i = args.indexOf(`--${name}`)
	return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}
const APPLY = args.includes('--apply')
const ASSUME = args.includes('--assume-role')
const account = flag('account')
const region = flag('region') || 'eu-north-1'
const deployRoleArn = flag('deploy-role-arn')
const parentZoneId = flag('parent-zone-id')
const reviewer = flag('reviewer')

if (!env || !['qa', 'live'].includes(env)) fail('first arg must be `qa` or `live`')
if (env === 'live') fail('live is the apex domain — needs the root zone in-account (see docs/PHOENIX.md); not supported by v1')
if (!account) fail('--account <id> is required')
if (!deployRoleArn) fail('--deploy-role-arn <arn> is required (the mf-github-deploy role in the env account)')

const subdomain = `${env}.${ROOT_DOMAIN}` // qa.mjukvaruhuset.se
const siteDomain = subdomain
const portalDomain = `portal.${subdomain}`
const apiDomain = `api.${subdomain}`

function fail(msg) {
	console.error(`provision-env: ${msg}`)
	process.exit(1)
}
const log = (...m) => console.log(...m)
const plan = m => log(`  ${APPLY ? 'APPLY' : 'PLAN '} ${m}`)

// MARK: shell helpers (call the aws / gh CLIs; JSON out). `env` overrides the process env (creds).
const sh = (cmd, cmdArgs, env) => execFileSync(cmd, cmdArgs, { encoding: 'utf8', ...(env ? { env } : {}) }).trim()

// `--assume-role`: run as the management account and assume OrganizationAccountAccessRole into the
// target account for its own calls (zone, certs). `rootEnv` (undefined = original creds) is used for
// the NS delegation into the parent/root zone, which lives in the management account today.
let targetEnv // undefined → original process env
if (ASSUME) {
	const roleArn = `arn:aws:iam::${account}:role/OrganizationAccountAccessRole`
	let creds
	try {
		creds = JSON.parse(
			sh('aws', ['sts', 'assume-role', '--role-arn', roleArn, '--role-session-name', 'mf-provision-env', '--output', 'json'])
		).Credentials
	} catch (e) {
		fail(`could not assume ${roleArn} — is ${account} an Organizations-created member account, and are you the management account? (${e.message})`)
	}
	targetEnv = {
		...process.env,
		AWS_ACCESS_KEY_ID: creds.AccessKeyId,
		AWS_SECRET_ACCESS_KEY: creds.SecretAccessKey,
		AWS_SESSION_TOKEN: creds.SessionToken,
	}
	delete targetEnv.AWS_PROFILE // an empty AWS_PROFILE reads as a profile named "" — must be unset
}
const aws = (cmdArgs, opts = {}) =>
	sh('aws', [...cmdArgs, '--output', 'json', ...(opts.region ? ['--region', opts.region] : [])], opts.env ?? targetEnv)
const awsJson = (cmdArgs, opts) => JSON.parse(aws(cmdArgs, opts) || 'null')
// In dry-run, mutating aws calls are printed, not run.
const awsWrite = (cmdArgs, opts) => (APPLY ? awsJson(cmdArgs, opts) : (plan(`aws ${cmdArgs.join(' ')}${opts?.region ? ' --region ' + opts.region : ''}`), null))

// MARK: account guard — the (possibly assumed) identity must be the target account
const callerAccount = awsJson(['sts', 'get-caller-identity']).Account
if (callerAccount !== account) {
	fail(
		ASSUME
			? `assumed identity is ${callerAccount}, not --account ${account} (unexpected)`
			: `caller account ${callerAccount} != --account ${account}. Authenticate to the ${env} account, or pass --assume-role from the management account.`
	)
}
log(`✓ ${ASSUME ? 'assumed OrganizationAccountAccessRole in' : 'authenticated to'} the ${env} account ${account}`)

// MARK: P4 — subdomain hosted zone + NS delegation
log(`\n[P4] hosted zone ${subdomain}`)
const zones = awsJson(['route53', 'list-hosted-zones-by-name', '--dns-name', subdomain]).HostedZones || []
const matchingZones = zones.filter(z => z.Name === `${subdomain}.`)
// list-hosted-zones-by-name is eventually consistent — the only guard against duping the zone was
// this list, which a re-run right after a just-created zone could still miss (hardening audit
// 2026-08-30, finding G1). More than one match means it already happened; fail loudly rather than
// silently picking one and risking certs/delegation landing in a zone the internet isn't routed to.
if (matchingZones.length > 1) {
	fail(
		`${matchingZones.length} hosted zones already exist for ${subdomain} (${matchingZones.map(z => z.Id).join(', ')}) — resolve the duplicate by hand before re-running`
	)
}
let zone = matchingZones[0]
let zoneId
if (zone) {
	zoneId = zone.Id.replace('/hostedzone/', '')
	log(`  exists: ${zoneId}`)
} else if (APPLY) {
	// A deterministic caller-reference (not Date.now()) makes a re-run that races the list's
	// eventual consistency idempotent: Route53 returns the EXISTING zone for a repeat of the same
	// (name, caller-reference) pair instead of creating a second one with a different NS set.
	const created = awsJson(['route53', 'create-hosted-zone', '--name', subdomain, '--caller-reference', `mf-${env}-zone`])
	zoneId = created.HostedZone.Id.replace('/hostedzone/', '')
	log(`  created: ${zoneId}`)
} else {
	plan(`aws route53 create-hosted-zone --name ${subdomain}`)
	zoneId = '<new-zone-id>'
}

// NS records for the delegation
let nsRecords = []
if (zoneId !== '<new-zone-id>') {
	const rrs = awsJson(['route53', 'list-resource-record-sets', '--hosted-zone-id', zoneId]).ResourceRecordSets || []
	nsRecords = (rrs.find(r => r.Type === 'NS' && r.Name === `${subdomain}.`)?.ResourceRecords || []).map(r => r.Value)
}
if (parentZoneId) {
	// Guard against a mistyped --parent-zone-id silently UPSERTing an NS record into an unrelated
	// zone (hardening audit 2026-08-30, finding D1): the parent zone must actually be an ancestor
	// of the subdomain we're delegating. Read-only, so it runs in dry-run too.
	const parentZoneName = awsJson(['route53', 'get-hosted-zone', '--id', parentZoneId], { env: process.env }).HostedZone
		?.Name
	if (!parentZoneName || !`${subdomain}.`.endsWith(parentZoneName)) {
		fail(
			`--parent-zone-id ${parentZoneId} is zone '${parentZoneName ?? '?'}', which does not own ${subdomain} — refusing to write an NS record there`
		)
	}
	log(`  delegating ${subdomain} in parent zone ${parentZoneId} (${parentZoneName})`)
	const batch = JSON.stringify({
		Changes: [{ Action: 'UPSERT', ResourceRecordSet: { Name: subdomain, Type: 'NS', TTL: 300, ResourceRecords: nsRecords.length ? nsRecords.map(v => ({ Value: v })) : [{ Value: '<ns>' }] } }],
	})
	try {
		// The root zone lives in the management account — use the ORIGINAL creds, not the assumed target.
		awsWrite(['route53', 'change-resource-record-sets', '--hosted-zone-id', parentZoneId, '--change-batch', batch], { env: process.env })
	} catch (e) {
		log(`  ! could not write to parent zone (different account?) — add this NS delegation by hand:`)
		nsRecords.forEach(v => log(`      ${subdomain}. NS ${v}`))
		// The delegation genuinely didn't happen — fail loudly instead of exiting 0 as if it had
		// (finding D1); the manual fallback printed above is still the right next step.
		fail(`NS delegation write to parent zone ${parentZoneId} failed: ${e.message}`)
	}
} else {
	log(`  no --parent-zone-id — add this NS delegation to the root zone by hand:`)
	nsRecords.forEach(v => log(`      ${subdomain}. NS ${v}`))
}

// MARK: P5 — ACM certs (CloudFront us-east-1 covers site+portal; API eu-north-1 covers api)
const ensureCert = (certRegion, primaryDomain, sans, label) => {
	log(`\n[P5] ${label} cert (${certRegion}) for ${[primaryDomain, ...sans].join(', ')}`)
	const list = awsJson(['acm', 'list-certificates'], { region: certRegion }).CertificateSummaryList || []
	// Reuse only a cert that (a) is still on a path to ISSUED — not a terminal FAILED/
	// VALIDATION_TIMED_OUT one from an earlier aborted run, which would dead-end every re-run
	// (hardening audit 2026-08-30, finding C1) — and (b) actually covers every SAN we need, not
	// just the primary domain (finding C3): reusing a cert missing the portal SAN would adopt a
	// cert CloudFront serves the portal on with a TLS SNI mismatch in every browser.
	const reusable = list.find(
		c =>
			c.DomainName === primaryDomain &&
			(c.Status === 'ISSUED' || c.Status === 'PENDING_VALIDATION') &&
			sans.every(san => (c.SubjectAlternativeNameSummaries || []).includes(san))
	)
	let arn = reusable?.CertificateArn
	if (arn) {
		log(`  exists: ${arn}`)
	} else if (APPLY) {
		const req = ['acm', 'request-certificate', '--domain-name', primaryDomain, '--validation-method', 'DNS']
		if (sans.length) req.push('--subject-alternative-names', ...sans)
		arn = awsJson(req, { region: certRegion }).CertificateArn
		log(`  requested: ${arn}`)
	} else {
		plan(`aws acm request-certificate --domain-name ${primaryDomain}${sans.length ? ' --subject-alternative-names ' + sans.join(' ') : ''} --region ${certRegion}`)
		return '<pending-cert-arn>'
	}
	// DNS validation records → upsert into the subdomain zone
	if (zoneId !== '<new-zone-id>') {
		// A JUST-requested cert has null ResourceRecords for a few seconds — poll until ACM populates
		// them, or the records never get added (the bug that left qa PENDING forever).
		let options = []
		for (let attempt = 0; attempt < 15; attempt++) {
			options =
				awsJson(['acm', 'describe-certificate', '--certificate-arn', arn], { region: certRegion }).Certificate
					.DomainValidationOptions || []
			if (options.length && options.every(o => o.ResourceRecord)) break
			execFileSync('sleep', ['2'])
		}
		const seen = new Set()
		for (const o of options) {
			const rr = o.ResourceRecord
			if (!rr || seen.has(rr.Name)) continue
			seen.add(rr.Name)
			const batch = JSON.stringify({ Changes: [{ Action: 'UPSERT', ResourceRecordSet: { Name: rr.Name, Type: rr.Type, TTL: 300, ResourceRecords: [{ Value: rr.Value }] } }] })
			awsWrite(['route53', 'change-resource-record-sets', '--hosted-zone-id', zoneId, '--change-batch', batch])
		}
		if (APPLY) {
			log(`  ${seen.size} validation record(s) in place; waiting for ISSUED…`)
			try {
				// targetEnv: the cert lives in the target account, so the waiter must use its creds.
				sh('aws', ['acm', 'wait', 'certificate-validated', '--certificate-arn', arn, '--region', certRegion], targetEnv)
				log(`  ISSUED`)
			} catch {
				// The waiter times out well before ACM's real 72h validation window closes, so a timeout
				// here doesn't necessarily mean the cert failed — re-check the actual status before
				// deciding. Finding C2 (hardening audit 2026-08-30): the old code logged a soft warning
				// and kept going with exit 0, publishing a not-yet-ISSUED ARN that CloudFront/ALB then
				// reject at deploy time — and re-runs kept publishing the same stuck ARN. Fail loudly
				// instead so the ARN is never written to config/GitHub with a status that can't deploy.
				const status = awsJson(['acm', 'describe-certificate', '--certificate-arn', arn], {
					region: certRegion,
				}).Certificate.Status
				if (status !== 'ISSUED') {
					fail(
						`${label} cert ${arn} is ${status}, not ISSUED, after the wait window — records are in place, ACM validates on its own; re-run this script once it clears (or if it's FAILED/VALIDATION_TIMED_OUT, delete it in ACM and re-run to request a fresh one)`
					)
				}
				log(`  ISSUED (confirmed after the wait window timed out)`)
			}
		}
	}
	return arn
}

const cloudFrontCertArn = ensureCert('us-east-1', siteDomain, [portalDomain], 'CloudFront')
const apiCertArn = ensureCert(region, apiDomain, [], 'API')

// MARK: P7 — GitHub environment
log(`\n[P7] GitHub environment '${env}'`)
const gh = ghArgs => (APPLY ? sh('gh', ghArgs) : plan(`gh ${ghArgs.join(' ')}`))
// create/ensure the environment (a required reviewer would be added here for live — reserved for later)
const envBody = reviewer ? JSON.stringify({ reviewers: [{ type: 'User', id: Number(reviewer) }] }) : '{}'
if (APPLY) {
	execFileSync('gh', ['api', '-X', 'PUT', `repos/${REPO}/environments/${env}`], { input: envBody, encoding: 'utf8' })
	log(`  ensured environment ${env}`)
} else {
	plan(`gh api -X PUT repos/${REPO}/environments/${env}  (body: ${envBody})`)
}
gh(['variable', 'set', 'AWS_ACCOUNT_ID', '--env', env, '--repo', REPO, '--body', account])
gh(['variable', 'set', 'AWS_REGION', '--env', env, '--repo', REPO, '--body', region])
// The per-env infra identity lib/config.ts reads (deploy-environment.yml passes them as MF_*).
gh(['variable', 'set', 'MF_HOSTED_ZONE_ID', '--env', env, '--repo', REPO, '--body', zoneId])
gh(['variable', 'set', 'MF_HOSTED_ZONE_NAME', '--env', env, '--repo', REPO, '--body', subdomain])
gh(['variable', 'set', 'MF_CLOUDFRONT_CERT_ARN', '--env', env, '--repo', REPO, '--body', cloudFrontCertArn])
gh(['variable', 'set', 'MF_API_CERT_ARN', '--env', env, '--repo', REPO, '--body', apiCertArn])
gh(['secret', 'set', 'AWS_DEPLOY_ROLE_ARN', '--env', env, '--repo', REPO, '--body', deployRoleArn])

// MARK: P6 — publish per-env infra values (consumed by config once item 1 lands)
log(`\n[P6] per-env infra values`)
const values = {
	MF_ACCOUNT: account,
	MF_REGION: region,
	MF_HOSTED_ZONE_ID: zoneId,
	MF_HOSTED_ZONE_NAME: subdomain,
	MF_CLOUDFRONT_CERT_ARN: cloudFrontCertArn,
	MF_API_CERT_ARN: apiCertArn,
}
const envFile = new URL(`../.env.${env}`, import.meta.url).pathname
const body = Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
if (APPLY) {
	writeFileSync(envFile, body)
	log(`  wrote ${envFile} (git-ignored; sourced by deploy.sh once config item 1 lands)`)
} else {
	log(`  would write ${envFile}:`)
	body.split('\n').filter(Boolean).forEach(l => log(`      ${l}`))
}

log(`\n${APPLY ? '✅ applied' : 'ℹ dry-run only — re-run with --apply to make changes'}. Summary:`)
Object.entries(values).forEach(([k, v]) => log(`  ${k}=${v}`))
