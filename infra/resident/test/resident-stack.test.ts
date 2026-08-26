import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'

import { loadConfig } from '../lib/config.ts'
import { ResidentStack } from '../lib/resident-stack.ts'

const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')

const synth = (context: Record<string, string> = {}) => {
	const app = new App({ context: { repository: 'acme/shop', ...context } })
	const config = loadConfig(app)
	const stack = new ResidentStack(app, `mf-resident-${config.installationId}`, {
		config,
		repositoryRoot,
	})
	return { config, template: Template.fromStack(stack) }
}

describe('ResidentStack', () => {
	const { config, template } = synth()

	it('derives the installation id from the repository and scopes the task to it', () => {
		assert.equal(config.installationId, 'acme--shop')
		template.hasResourceProperties('AWS::ECS::TaskDefinition', {
			ContainerDefinitions: [
				Match.objectLike({
					Environment: Match.arrayWith([
						{ Name: 'GITHUB_REPOSITORY', Value: 'acme/shop' },
						{ Name: 'RESIDENT_INSTALLATION_ID', Value: 'acme--shop' },
						{ Name: 'RESIDENT_MONTHLY_TOKENS', Value: '50000000' },
						{ Name: 'FACTORY_API_URL', Value: 'https://api.mjukvaruhuset.se' },
					]),
				}),
			],
		})
	})

	it('creates the four secrets and passes only their ARNs to the container', () => {
		template.resourceCountIs('AWS::SecretsManager::Secret', 4)
		for (const name of ['anthropic-api-key', 'github-token', 'factory-token']) {
			// A JSON placeholder the resident recognises as "not configured" (a bare random string would pass for a credential)
			template.hasResourceProperties('AWS::SecretsManager::Secret', {
				Name: `mf-resident/acme--shop/${name}`,
				GenerateSecretString: Match.objectLike({
					SecretStringTemplate: '{"placeholder":"fill via put-secret-value"}',
					GenerateStringKey: name,
				}),
			})
		}
		template.hasResourceProperties('AWS::SecretsManager::Secret', {
			Name: 'mf-resident/acme--shop/admin-token',
			GenerateSecretString: Match.not(Match.objectLike({ SecretStringTemplate: Match.anyValue() })),
		})
		const [definition] = Object.values(template.findResources('AWS::ECS::TaskDefinition'))
		const [container] = definition!.Properties.ContainerDefinitions as {
			Environment: { Name: string; Value: unknown }[]
			Secrets?: unknown[]
		}[]
		// No ECS secret injection either: the initial environment of pid 1 is readable from /proc
		// by the worker sessions, which share the container
		assert.equal(container!.Secrets, undefined)
		for (const { Name, Value } of container!.Environment) {
			assert.ok(
				typeof Value !== 'string' || !/sk-ant|ghp_|whsec_/.test(Value),
				`${Name} looks like a credential`
			)
			if (Name.endsWith('_SECRET_ARN'))
				assert.ok(typeof Value === 'object', `${Name} is an ARN ref`)
		}
	})

	it('grants the task role read on the secrets and read + put (never delete) on the bucket, nothing else', () => {
		const policies = Object.values(template.findResources('AWS::IAM::Policy')).filter(policy =>
			JSON.stringify(policy).includes('TaskDefinitionTaskRole')
		)
		assert.equal(policies.length, 1)
		const statements = policies[0]!.Properties.PolicyDocument.Statement as {
			Action: string | string[]
		}[]
		const actions = statements.flatMap(statement => [statement.Action].flat())
		const s3Actions = actions.filter(action => action.startsWith('s3:')).sort()
		// Exactly what store.ts uses (Get/Put/List); the versioned audit trail is not erasable
		assert.deepEqual(s3Actions, [
			's3:Abort*',
			's3:GetBucket*',
			's3:GetObject*',
			's3:List*',
			's3:PutObject',
			's3:PutObjectLegalHold',
			's3:PutObjectRetention',
			's3:PutObjectTagging',
			's3:PutObjectVersionTagging',
		])
		for (const action of actions) {
			assert.ok(
				// ssmmessages + logs: ECS Exec (`aws ecs execute-command`), the pause path without an ALB
				/^(secretsmanager:(GetSecretValue|DescribeSecret)|s3:.*|ssmmessages:.*|logs:.*)$/.test(
					action
				),
				`unexpected action ${action}`
			)
		}
	})

	it('runs one task on Fargate in public subnets without a NAT gateway, bucket retained', () => {
		template.resourceCountIs('AWS::EC2::NatGateway', 0)
		template.hasResourceProperties('AWS::ECS::Service', {
			DesiredCount: 1,
			LaunchType: 'FARGATE',
			DeploymentConfiguration: { MinimumHealthyPercent: 0, MaximumPercent: 100 },
			NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: 'ENABLED' } },
		})
		template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0)
		template.hasResource('AWS::S3::Bucket', {
			DeletionPolicy: 'Retain',
			Properties: Match.objectLike({
				VersioningConfiguration: { Status: 'Enabled' },
				PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }),
			}),
		})
	})

	it('puts the control api behind a public HTTPS load balancer only when asked, and only with a certificate', () => {
		const certificateArn = 'arn:aws:acm:eu-north-1:123456789012:certificate/abc'
		const exposed = synth({ exposeApi: 'true', installationId: 'acme-prod', certificateArn }).template
		exposed.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1)
		exposed.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
			Port: 443,
			Protocol: 'HTTPS',
			Certificates: [{ CertificateArn: certificateArn }],
		})
		exposed.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
			Port: 80,
			DefaultActions: [Match.objectLike({ Type: 'redirect' })],
		})
		exposed.hasOutput('ControlApiUrl', {})
		assert.throws(() => synth({ exposeApi: 'true', installationId: 'acme-http' }), /certificateArn/)
	})
})
