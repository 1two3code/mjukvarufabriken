import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Match } from 'aws-cdk-lib/assertions'

import { synthEnvironment } from './helpers.ts'

import type { Template } from 'aws-cdk-lib/assertions'

type ContainerDefinition = {
	Name: string
	Environment?: { Name: string; Value: unknown }[]
	Secrets?: unknown[]
}

const containersOf = (template: Template) =>
	Object.values(template.findResources('AWS::ECS::TaskDefinition')).flatMap(
		r => (r.Properties as { ContainerDefinitions: ContainerDefinition[] }).ContainerDefinitions
	)

/**
 * Env var names that would carry a credential unless they only point at Secrets Manager.
 * `*_URL` is allowed by name (SITE_URL, AUTH_ISSUER…) — a credential-carrying URL is caught
 * by value below.
 */
const looksSecret = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|_DSN$|_AUTH$/i

/** Values that are a credential no matter what the variable is called */
const secretValuePatterns = [
	/sk-ant-/, // Anthropic
	/\bsk_(live|test)_/, // Stripe secret key
	/\bwhsec_/, // Stripe webhook secret
	/\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
	/\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
	/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]+@/i, // URL with user:password@ (DATABASE_URL, SMTP_URL, DSNs)
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/^[A-Za-z0-9+/]{40,}={0,2}$/, // long bare base64 blob
]

/** A `_SECRET_ARN` value must be a template reference or a literal Secrets Manager ARN */
const isSecretArnValue = (value: unknown) => {
	if (typeof value === 'string') return /^arn:aws[\w-]*:secretsmanager:/.test(value)
	if (typeof value !== 'object' || value === null) return false
	return Object.keys(value).some(key => key === 'Ref' || key.startsWith('Fn::'))
}

describe('security baseline', () => {
	for (const env of ['dev', 'live'] as const) {
		describe(env, () => {
			const { resources, web } = synthEnvironment(env)

			it('keeps every secret in Secrets Manager — no plaintext credentials in task definitions', () => {
				const containers = [...containersOf(resources), ...containersOf(web)]
				assert.ok(containers.length >= 3, 'expected job, proxy and api containers')
				for (const container of containers) {
					for (const { Name, Value } of container.Environment ?? []) {
						const label = `${container.Name}: ${Name}`
						if (Name.endsWith('_SECRET_ARN')) {
							assert.ok(isSecretArnValue(Value), `${label} must reference a Secrets Manager ARN`)
							continue
						}
						assert.ok(!looksSecret.test(Name), `${label} looks like a plaintext secret`)
						// Whatever the name, the value itself must not look like a credential
						const text = typeof Value === 'string' ? Value : JSON.stringify(Value)
						for (const pattern of secretValuePatterns) {
							assert.ok(!pattern.test(text), `${label} value matches ${pattern}`)
						}
					}
					// The api and job read secrets themselves at start-up; nothing is injected
					assert.equal(container.Secrets, undefined, `${container.Name}: unexpected Secrets`)
				}
			})

			it('grants the job task role only the Anthropic key and artifact writes — no database', () => {
				const policies = Object.values(resources.findResources('AWS::IAM::Policy'))
				const jobPolicy = policies.find(p =>
					JSON.stringify(p.Properties).includes('JobTaskDefinitionTaskRole')
				)
				assert.ok(jobPolicy, 'job task role policy')
				const statements = (
					jobPolicy.Properties as { PolicyDocument: { Statement: { Action: unknown }[] } }
				).PolicyDocument.Statement
				const actions = statements.flatMap(s => (Array.isArray(s.Action) ? s.Action : [s.Action]))
				// grantPut, not grantWrite: a job may upload but never delete or overwrite-by-delete
				assert.deepEqual(
					new Set(actions),
					new Set([
						'secretsmanager:GetSecretValue',
						'secretsmanager:DescribeSecret',
						's3:PutObject',
						's3:PutObjectLegalHold',
						's3:PutObjectRetention',
						's3:PutObjectTagging',
						's3:PutObjectVersionTagging',
						's3:Abort*',
					])
				)
				// One secret only — never the RDS master secret, Stripe, the auth key or the GitHub token
				const secretStatements = statements.filter(s =>
					JSON.stringify(s.Action).includes('secretsmanager')
				)
				assert.equal(secretStatements.length, 1)
				assert.ok(
					!JSON.stringify(jobPolicy.Properties).includes('DatabaseSecret'),
					'job task role must not reference the database secret'
				)
			})

			it('keeps the job task off the database: no DATABASE_* env, no 5432 rule, api url via the api', () => {
				const job = containersOf(resources).find(c => c.Name === 'job')!
				const names = (job.Environment ?? []).map(e => e.Name)
				assert.ok(!names.some(n => n.startsWith('DATABASE_')), `job env: ${names.join(',')}`)
				const rules = [
					...Object.values(resources.findResources('AWS::EC2::SecurityGroupEgress')),
					...Object.values(resources.findResources('AWS::EC2::SecurityGroupIngress')),
				]
				const postgresRules = rules.filter(
					r => (r.Properties as { FromPort?: number }).FromPort === 5432
				)
				assert.equal(postgresRules.length, 0, 'no job <-> postgres security-group rule')
				const apiEnv = containersOf(web)
					.flatMap(c => c.Environment ?? [])
					.map(e => e.Name)
				assert.ok(apiEnv.includes('JOB_API_URL') && apiEnv.includes('JOB_NO_PROXY'))
			})

			it('sets the CloudFront security headers', () => {
				web.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
					ResponseHeadersPolicyConfig: {
						SecurityHeadersConfig: Match.objectLike({
							ContentTypeOptions: { Override: true },
							FrameOptions: { FrameOption: 'DENY', Override: true },
							StrictTransportSecurity: Match.objectLike({
								AccessControlMaxAgeSec: 31536000,
								IncludeSubdomains: true,
							}),
							ContentSecurityPolicy: Match.objectLike({
								ContentSecurityPolicy: Match.stringLikeRegexp("frame-ancestors 'none'"),
							}),
						}),
					},
				})
			})

			it('has backups: RDS retention, versioned artifacts with 90-day noncurrent expiry', () => {
				resources.hasResourceProperties('AWS::RDS::DBInstance', {
					BackupRetentionPeriod: env === 'live' ? 30 : 7,
					DeletionProtection: env === 'live',
					StorageEncrypted: true,
				})
				resources.hasResource('AWS::RDS::DBInstance', {
					DeletionPolicy: env === 'live' ? 'Snapshot' : 'Delete',
				})
				resources.hasResourceProperties('AWS::S3::Bucket', {
					VersioningConfiguration: { Status: 'Enabled' },
					LifecycleConfiguration: {
						Rules: Match.arrayWith([
							Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 90 } }),
						]),
					},
				})
			})

			it('writes api and job logs to named groups with retention', () => {
				resources.hasResourceProperties('AWS::Logs::LogGroup', {
					LogGroupName: `/mf/${env}/jobs`,
					RetentionInDays: 14,
				})
				web.hasResourceProperties('AWS::Logs::LogGroup', {
					LogGroupName: `/mf/${env}/api`,
					RetentionInDays: env === 'live' ? 30 : 14,
				})
			})
		})
	}
})
