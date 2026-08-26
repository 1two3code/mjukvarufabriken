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

/** Env var names that would carry a credential unless they only point at Secrets Manager */
const looksSecret = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i

describe('security baseline', () => {
	for (const env of ['dev', 'live'] as const) {
		describe(env, () => {
			const { resources, web } = synthEnvironment(env)

			it('keeps every secret in Secrets Manager — no plaintext credentials in task definitions', () => {
				const containers = [...containersOf(resources), ...containersOf(web)]
				assert.ok(containers.length >= 3, 'expected job, proxy and api containers')
				for (const container of containers) {
					for (const { Name } of container.Environment ?? []) {
						assert.ok(
							!looksSecret.test(Name) || Name.endsWith('_SECRET_ARN'),
							`${container.Name}: ${Name} looks like a plaintext secret`
						)
					}
					// The api and job read secrets themselves at start-up; nothing is injected
					assert.equal(container.Secrets, undefined, `${container.Name}: unexpected Secrets`)
				}
			})

			it('grants the job task role only the db secret, the Anthropic key and artifact writes', () => {
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
				// Two secrets only — never Stripe, the auth key or the GitHub token
				const secretStatements = statements.filter(s =>
					JSON.stringify(s.Action).includes('secretsmanager')
				)
				assert.equal(secretStatements.length, 2)
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
