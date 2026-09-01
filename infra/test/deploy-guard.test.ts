import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Match } from 'aws-cdk-lib/assertions'

import { config } from '../lib/config.ts'
import { assertDeployableEnvironment } from '../lib/deploy-guard.ts'
import { synthEnvironment } from './helpers.ts'

import type { EnvironmentConfig } from '../lib/config.ts'

const environmentOf = (name: 'dev' | 'qa' | 'live') =>
	config.environments.find(e => e.name === name)!

/**
 * A deploy of an environment without a `domain` comes up on plain HTTP with no working sign-in
 * (audit 2026-08-31, P0-5): the api ALB loses `protocol: HTTPS` + `redirectHTTP`, CloudFront
 * reaches it `HTTP_ONLY`, and the SES identity + grant are never created even though live sets
 * `email.transport: 'ses'`. Nothing stopped that: the only signal was a non-blocking annotation,
 * and `scripts/check-live-domain.ts` was wired into `deploy.sh` but not into the GitHub workflow.
 */
describe('deploy guard', () => {
	it('refuses the environment named by MF_ENV when it has no domain', () => {
		const live = environmentOf('live')
		assert.equal(live.domain, undefined, 'precondition: live still has no domain (TODO-EXTERNAL)')
		assert.throws(
			() => assertDeployableEnvironment(live, 'live'),
			/refusing to synthesise live for deploy: no `domain` is configured/
		)
	})

	it('allows the environments that do have a domain', () => {
		for (const name of ['dev', 'qa'] as const) {
			const environment = environmentOf(name)
			assert.ok(environment.domain, `precondition: ${name} has a domain`)
			assert.doesNotThrow(() => assertDeployableEnvironment(environment, name))
		}
	})

	it('is a no-op for CI’s offline all-env synth (MF_ENV unset) and for other envs', () => {
		const live = environmentOf('live')
		// Unset MF_ENV — nothing is being deployed, so live may still be synthesised
		assert.doesNotThrow(() => assertDeployableEnvironment(live, undefined))
		assert.doesNotThrow(() => assertDeployableEnvironment(live, ''))
		// A dev deploy must not trip over live's missing domain
		assert.doesNotThrow(() => assertDeployableEnvironment(live, 'dev'))
	})

	it('does not fire on a domain-less environment that is not the deploy target', () => {
		const domainless: EnvironmentConfig = { ...environmentOf('dev'), domain: undefined }
		assert.doesNotThrow(() => assertDeployableEnvironment(domainless, 'qa'))
		assert.throws(() => assertDeployableEnvironment(domainless, 'dev'))
	})

	// End-to-end through the real CDK entry point: this is the assertion that would have caught the
	// gap, since the guard is only worth anything if bin/app.ts actually calls it. `MF_ENV=live`
	// must fail before a single construct exists — well before the missing apps/*/dist/live assets
	// would have failed the synth for an unrelated reason, hence the message match.
	it('fails `MF_ENV=live cdk synth` at bin/app.ts, before any construct is created', () => {
		const result = spawnSync(
			process.execPath,
			['--import', 'tsx', path.join(import.meta.dirname, '../bin/app.ts')],
			{
				cwd: path.join(import.meta.dirname, '..'),
				encoding: 'utf8',
				env: {
					...process.env,
					MF_ENV: 'live',
					// Keep any auto-synth out of the checked-in infra/cdk.out
					CDK_OUTDIR: mkdtempSync(path.join(tmpdir(), 'mf-cdk-out-')),
				},
			}
		)
		assert.notEqual(result.status, 0, 'MF_ENV=live must not synthesise')
		const output = `${result.stdout}${result.stderr}`
		assert.match(output, /refusing to synthesise live for deploy/)
		// Not the incidental "asset does not exist" failure a live synth would hit anyway
		assert.doesNotMatch(output, /Cannot find asset/)
	})
})

/**
 * TLS floor on the two CloudFront distributions (audit 2026-08-31, P0-5 appendix #3).
 *
 * Left implicit, CDK derives it from the `@aws-cdk/aws-cloudfront:defaultSecurityPolicyTLSv1.2_2021`
 * feature flag: TLS_V1_2_2021 when it is on, TLS_V1_2_2019 when it is off. `infra/cdk.json` sets no
 * feature flags at all, so the whole TLS floor of every domain we serve hangs off a CDK default we
 * do not control — and TLS_V1_2_2019 still negotiates the older cipher-suite set. The flag-off case
 * below is the one that actually distinguishes an explicit `minimumProtocolVersion` from an
 * inherited one.
 */
describe('CloudFront TLS floor', () => {
	const tlsVersionsOf = (
		distributions: { Properties?: Record<string, unknown> }[]
	): (string | undefined)[] =>
		distributions.map(
			distribution =>
				(
					distribution.Properties as {
						DistributionConfig: { ViewerCertificate?: { MinimumProtocolVersion?: string } }
					}
				).DistributionConfig.ViewerCertificate?.MinimumProtocolVersion
		)

	for (const env of ['dev', 'qa'] as const) {
		it(`pins ${env}'s distributions to TLSv1.2_2021`, () => {
			const { web } = synthEnvironment(env)
			web.resourceCountIs('AWS::CloudFront::Distribution', 2)
			web.hasResourceProperties('AWS::CloudFront::Distribution', {
				DistributionConfig: Match.objectLike({
					ViewerCertificate: Match.objectLike({ MinimumProtocolVersion: 'TLSv1.2_2021' }),
				}),
			})
		})

		it(`keeps ${env} on TLSv1.2_2021 even with the CDK feature flag off`, () => {
			const { web } = synthEnvironment(env, {
				'@aws-cdk/aws-cloudfront:defaultSecurityPolicyTLSv1.2_2021': false,
			})
			const versions = tlsVersionsOf(
				Object.values(web.findResources('AWS::CloudFront::Distribution'))
			)
			assert.equal(versions.length, 2, 'site + portal')
			assert.deepEqual(versions, ['TLSv1.2_2021', 'TLSv1.2_2021'])
		})
	}
})
