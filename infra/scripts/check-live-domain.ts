// Deploy-time guard for `live` (hardening audit 2026-08-30, finding B1; re-scoped by the
// 2026-08-31 audit, P0-5). live's `email.transport` is `'ses'`, but the SES `EmailIdentity` +
// `ses:SendEmail` grant are only created `if (domain)` (resources-stack.ts) — and without a domain
// the api ALB also falls back to a plain HTTP:80 listener with CloudFront reaching it HTTP_ONLY.
//
// The check now lives in `lib/deploy-guard.ts` and is enforced at synth as well (bin/app.ts fails
// for whichever env `MF_ENV` names). Its old header claimed a synth-time check was impossible
// because CI synthesizes every environment — that was already stale: bin/app.ts gates on `MF_ENV`,
// which only a real deploy sets. This script stays as the cheap outer layer: `deploy.sh` and
// `.github/workflows/deploy-environment.yml` run it in seconds, before `npm ci` + the SPA build.
import { config } from '../lib/config.ts'
import { assertDeployableEnvironment } from '../lib/deploy-guard.ts'

const live = config.environments.find(environment => environment.name === 'live')
if (!live) {
	console.error('refusing: no `live` environment in infra/lib/config.ts')
	process.exit(1)
}

try {
	assertDeployableEnvironment(live, 'live')
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error))
	process.exit(1)
}
