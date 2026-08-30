#!/usr/bin/env node
// Provision the DNS + certs + GitHub environment for a platform env (Phoenix primitive P4–P7).
// See docs/PHOENIX.md. Idempotent and DRY-RUN BY DEFAULT — pass --apply to make changes.
//
//   node infra/scripts/provision-env.mjs qa \
//     --account 111122223333 --deploy-role-arn arn:aws:iam::111122223333:role/mf-github-deploy \
//     [--parent-zone-id Z0ROOT] [--region eu-north-1] [--reviewer <github-user-id>] [--apply]
//
// Preconditions: you are authenticated to the TARGET env account (the one whose id you pass as
// --account); `gh` is authenticated for the repo. The script refuses to run if the caller's AWS
// account does not match --account (the wrong-account footgun). Certs validate against the env's
// OWN subdomain zone, so the zone must be delegated from the root (P4 does the delegation record
// when --parent-zone-id is given and reachable; otherwise it prints the NS records to add by hand).
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

// MARK: shell helpers (call the aws / gh CLIs; JSON out)
const sh = (cmd, cmdArgs) => execFileSync(cmd, cmdArgs, { encoding: 'utf8' }).trim()
const aws = (cmdArgs, opts = {}) => sh('aws', [...cmdArgs, '--output', 'json', ...(opts.region ? ['--region', opts.region] : [])])
const awsJson = (cmdArgs, opts) => JSON.parse(aws(cmdArgs, opts) || 'null')
// In dry-run, mutating aws calls are printed, not run.
const awsWrite = (cmdArgs, opts) => (APPLY ? awsJson(cmdArgs, opts) : (plan(`aws ${cmdArgs.join(' ')}${opts?.region ? ' --region ' + opts.region : ''}`), null))

// MARK: account guard
const callerAccount = awsJson(['sts', 'get-caller-identity']).Account
if (callerAccount !== account) {
	fail(`caller account ${callerAccount} != --account ${account}. Authenticate to the ${env} account first (wrong-account guard).`)
}
log(`✓ authenticated to the ${env} account ${account}`)

// MARK: P4 — subdomain hosted zone + NS delegation
log(`\n[P4] hosted zone ${subdomain}`)
const zones = awsJson(['route53', 'list-hosted-zones-by-name', '--dns-name', subdomain]).HostedZones || []
let zone = zones.find(z => z.Name === `${subdomain}.`)
let zoneId
if (zone) {
	zoneId = zone.Id.replace('/hostedzone/', '')
	log(`  exists: ${zoneId}`)
} else if (APPLY) {
	const created = awsJson(['route53', 'create-hosted-zone', '--name', subdomain, '--caller-reference', `mf-${env}-${Date.now()}`])
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
	log(`  delegating ${subdomain} in parent zone ${parentZoneId}`)
	const batch = JSON.stringify({
		Changes: [{ Action: 'UPSERT', ResourceRecordSet: { Name: subdomain, Type: 'NS', TTL: 300, ResourceRecords: nsRecords.length ? nsRecords.map(v => ({ Value: v })) : [{ Value: '<ns>' }] } }],
	})
	try {
		awsWrite(['route53', 'change-resource-record-sets', '--hosted-zone-id', parentZoneId, '--change-batch', batch])
	} catch {
		log(`  ! could not write to parent zone (different account?) — add this NS delegation by hand:`)
		nsRecords.forEach(v => log(`      ${subdomain}. NS ${v}`))
	}
} else {
	log(`  no --parent-zone-id — add this NS delegation to the root zone by hand:`)
	nsRecords.forEach(v => log(`      ${subdomain}. NS ${v}`))
}

// MARK: P5 — ACM certs (CloudFront us-east-1 covers site+portal; API eu-north-1 covers api)
const ensureCert = (certRegion, primaryDomain, sans, label) => {
	log(`\n[P5] ${label} cert (${certRegion}) for ${[primaryDomain, ...sans].join(', ')}`)
	const list = awsJson(['acm', 'list-certificates'], { region: certRegion }).CertificateSummaryList || []
	let arn = list.find(c => c.DomainName === primaryDomain)?.CertificateArn
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
		const desc = awsJson(['acm', 'describe-certificate', '--certificate-arn', arn], { region: certRegion }).Certificate
		const options = desc.DomainValidationOptions || []
		const seen = new Set()
		for (const o of options) {
			const rr = o.ResourceRecord
			if (!rr || seen.has(rr.Name)) continue
			seen.add(rr.Name)
			const batch = JSON.stringify({ Changes: [{ Action: 'UPSERT', ResourceRecordSet: { Name: rr.Name, Type: rr.Type, TTL: 300, ResourceRecords: [{ Value: rr.Value }] } }] })
			awsWrite(['route53', 'change-resource-record-sets', '--hosted-zone-id', zoneId, '--change-batch', batch])
		}
		if (APPLY) {
			log(`  waiting for validation (ISSUED)…`)
			try {
				sh('aws', ['acm', 'wait', 'certificate-validated', '--certificate-arn', arn, '--region', certRegion])
				log(`  ISSUED`)
			} catch {
				log(`  ! not yet ISSUED — re-run once the NS delegation has propagated`)
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
