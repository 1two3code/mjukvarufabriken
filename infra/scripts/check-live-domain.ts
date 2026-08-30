// Deploy-time guard for `live` (hardening audit 2026-08-30, finding B1): live's `email.transport`
// is `'ses'`, but the SES `EmailIdentity` + `ses:SendEmail` grant are only created `if (domain)`
// (resources-stack.ts). Without a domain, magic-link email silently fails (unverified identity /
// no IAM grant) — and live has no `githubOAuth` fallback, so the sole admin could never sign in
// to a "successfully" deployed live. This can't be a synth-time check (CI's offline `cdk synth`
// synthesizes every environment, live included, before a domain ever exists) — it only runs when
// an operator is actually about to deploy live.
import { config } from '../lib/config.ts'

const live = config.environments.find(environment => environment.name === 'live')
if (!live?.domain) {
	console.error(
		'refusing: live has no domain configured (lib/config.ts) — email.transport is "ses" but ' +
			'the SES identity/grant only exist with a domain, and live has no githubOAuth fallback, ' +
			'so the sole admin could never sign in to a "successfully" deployed live. Configure ' +
			"environment.domain for live (infra/README.md \"Custom domains\") before deploying."
	)
	process.exit(1)
}
