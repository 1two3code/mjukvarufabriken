import type { EnvironmentConfig } from './config.ts'

/**
 * Synth-time guard: an environment must not be DEPLOYED without a `domain`.
 *
 * Without `environment.domain` three things silently degrade (audit 2026-08-31, P0-5):
 *  - `web-stack.ts` drops `protocol: HTTPS` + `redirectHTTP` from the api's
 *    `ApplicationLoadBalancedFargateService`, so the ALB falls back to a plain HTTP:80 listener —
 *    session cookies and per-job bearer tokens in cleartext.
 *  - the `/bff/*` CloudFront behaviour falls back to `OriginProtocolPolicy.HTTP_ONLY`, so the
 *    CloudFront → ALB hop crosses the public internet unencrypted.
 *  - `resources-stack.ts` only creates the SES `EmailIdentity` (and its `ses:SendEmail` grant)
 *    `if (environment.domain)`, while live sets `email.transport: 'ses'` and has no `githubOAuth`
 *    fallback — magic-link sign-in fails and the sole admin can never sign in to a
 *    "successfully" deployed live.
 *
 * Until now the only signals were a non-blocking `Annotations.addWarningV2` (both deploy paths
 * pass `--require-approval never`) and `scripts/check-live-domain.ts`, which `deploy.sh` calls but
 * `.github/workflows/deploy-environment.yml` never did.
 *
 * This CAN be a synth-time check even though CI's offline `cdk synth` synthesizes every
 * environment: `bin/app.ts` only builds the env named by `MF_ENV`, and both deploy paths set it
 * (`deploy.sh` and `deploy-environment.yml`). With `MF_ENV` unset — CI's all-env synth — nothing
 * is being deployed and the guard is a no-op. That is why it takes the deploy target explicitly
 * instead of reading `process.env` itself: it is also what makes it testable.
 *
 * Note this is the interim measure, not the destination. The real fix is to give `live` a `domain`
 * block with `fromEnv(...)` + `PENDING-LIVE-*` fallbacks the way `qa` has one, which removes the
 * HTTP path instead of only refusing it — blocked on the live ACM certificates (TODO-EXTERNAL.md).
 *
 * @param environment the environment about to be synthesised
 * @param deployTarget `process.env.MF_ENV` — undefined for CI's offline all-env synth
 */
export const assertDeployableEnvironment = (
	environment: EnvironmentConfig,
	deployTarget: string | undefined
) => {
	if (!deployTarget || deployTarget !== environment.name) return
	if (environment.domain) return
	throw new Error(
		`refusing to synthesise ${environment.name} for deploy: no \`domain\` is configured for it ` +
			'(infra/lib/config.ts). Without one the api ALB serves plain HTTP:80 with no redirect, ' +
			'CloudFront reaches it over HTTP_ONLY, and the SES identity + ses:SendEmail grant are ' +
			'never created — so magic-link sign-in fails too. Configure `environment.domain` ' +
			'(infra/README.md "Custom domains") before deploying, or unset MF_ENV for an offline synth.'
	)
}
