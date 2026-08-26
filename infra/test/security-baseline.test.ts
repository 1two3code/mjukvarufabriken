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

			it('grants the job task role only the db/Anthropic/GitHub secrets, artifact writes and App Runner previews', () => {
				const policies = Object.values(resources.findResources('AWS::IAM::Policy'))
				const jobPolicy = policies.find(p =>
					JSON.stringify(p.Properties).includes('JobTaskDefinitionTaskRole')
				)
				assert.ok(jobPolicy, 'job task role policy')
				const statements = (
					jobPolicy.Properties as { PolicyDocument: { Statement: { Action: unknown }[] } }
				).PolicyDocument.Statement
				const actions = statements.flatMap(s => (Array.isArray(s.Action) ? s.Action : [s.Action]))
				// grantPut, not grantWrite: a job may upload but never delete or overwrite-by-delete.
				// App Runner: create/inspect/redeploy preview services, never delete or pause them.
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
						'apprunner:CreateService',
						'apprunner:DescribeService',
						'apprunner:ListServices',
						'apprunner:StartDeployment',
						'apprunner:TagResource',
						'iam:PassRole',
					])
				)
				// Three secrets only — the RDS secret, the Anthropic key and (M5) the GitHub token;
				// never Stripe or the auth signing key
				const secretStatements = statements.filter(s =>
					JSON.stringify(s.Action).includes('secretsmanager')
				)
				assert.equal(secretStatements.length, 3)
				assert.ok(
					!JSON.stringify(secretStatements).match(/stripe|authjwt/i),
					'job role must not read Stripe or auth secrets'
				)
				// App Runner: only services tagged `Service=mf-delivery` (created by the job itself)
				const byActions = (action: string) =>
					statements.find(s => JSON.stringify(s.Action).includes(action)) as
						| { Condition: unknown }
						| undefined
				assert.deepEqual(byActions('apprunner:CreateService')?.Condition, {
					StringEquals: { 'aws:RequestTag/Service': 'mf-delivery' },
				})
				assert.deepEqual(byActions('apprunner:StartDeployment')?.Condition, {
					StringEquals: { 'aws:ResourceTag/Service': 'mf-delivery' },
				})
				assert.deepEqual(byActions('apprunner:DescribeService')?.Condition, {
					StringEquals: { 'aws:ResourceTag/Service': 'mf-delivery' },
				})
				// PassRole is limited to the empty App Runner instance role, and only to App Runner
				const passRole = statements.find(
					s => JSON.stringify(s.Action) === JSON.stringify('iam:PassRole')
				) as { Resource: unknown; Condition: unknown } | undefined
				assert.ok(passRole, 'iam:PassRole statement')
				assert.deepEqual(passRole.Condition, {
					StringEquals: { 'iam:PassedToService': 'tasks.apprunner.amazonaws.com' },
				})
				assert.ok(
					JSON.stringify(passRole.Resource).includes('AppRunnerInstanceRole'),
					'PassRole must target the App Runner instance role only'
				)
			})

			it('gives the App Runner instance role no policies at all', () => {
				const roles = Object.values(resources.findResources('AWS::IAM::Role'))
				const instanceRole = roles.find(r =>
					JSON.stringify(r.Properties).includes('tasks.apprunner.amazonaws.com')
				) as { Properties: { Policies?: unknown; ManagedPolicyArns?: unknown } } | undefined
				assert.ok(instanceRole, 'App Runner instance role')
				assert.equal(instanceRole.Properties.Policies, undefined)
				assert.equal(instanceRole.Properties.ManagedPolicyArns, undefined)
				const policies = Object.values(resources.findResources('AWS::IAM::Policy'))
				assert.ok(
					!policies.some(p => JSON.stringify(p.Properties.Roles).includes('AppRunnerInstanceRole')),
					'no inline policy attached to the App Runner instance role'
				)
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
