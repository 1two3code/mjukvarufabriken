import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'

import {
	DEFAULT_CERTIFICATE_ARN,
	DEFAULT_DOMAIN_NAME,
	DEFAULT_HOSTED_ZONE_NAME,
	loadConfig,
} from '../lib/config.ts'
import { StatusStack } from '../lib/status-stack.ts'

const synth = (context: Record<string, string> = {}) => {
	const app = new App({ context })
	const config = loadConfig(app)
	const stack = new StatusStack(app, 'mf-status', { config })
	return { config, template: Template.fromStack(stack) }
}

describe('StatusStack', () => {
	const { config, template } = synth()

	it('synthesises offline with checked-in defaults, no context or AWS calls needed', () => {
		assert.equal(config.hostedZoneName, DEFAULT_HOSTED_ZONE_NAME)
		assert.equal(config.domainName, DEFAULT_DOMAIN_NAME)
		assert.equal(config.certificateArn, DEFAULT_CERTIFICATE_ARN)
	})

	it('runs the Uptime Kuma image as the sole container of one small Fargate task', () => {
		template.hasResourceProperties('AWS::ECS::TaskDefinition', {
			Cpu: '256',
			Memory: '512',
			ContainerDefinitions: Match.arrayWith([
				Match.objectLike({ Image: 'louislam/uptime-kuma:1', PortMappings: [{ ContainerPort: 3001 }] }),
			]),
		})
		template.resourceCountIs('AWS::ECS::TaskDefinition', 1)
	})

	it('mounts an EFS access point for persistent SQLite state', () => {
		template.resourceCountIs('AWS::EFS::FileSystem', 1)
		template.hasResourceProperties('AWS::EFS::AccessPoint', {
			PosixUser: { Uid: '0', Gid: '0' },
			RootDirectory: Match.objectLike({ Path: '/data' }),
		})
		template.hasResourceProperties('AWS::ECS::TaskDefinition', {
			Volumes: Match.arrayWith([
				Match.objectLike({
					EFSVolumeConfiguration: Match.objectLike({
						TransitEncryption: 'ENABLED',
						AuthorizationConfig: Match.objectLike({ IAM: 'ENABLED' }),
					}),
				}),
			]),
		})
	})

	it('terminates HTTPS on the configured domain and redirects plain HTTP', () => {
		template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
			Protocol: 'HTTPS',
			Certificates: Match.arrayWith([Match.objectLike({ CertificateArn: DEFAULT_CERTIFICATE_ARN })]),
		})
		template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
			Protocol: 'HTTP',
			DefaultActions: Match.arrayWith([Match.objectLike({ Type: 'redirect' })]),
		})
		template.hasResourceProperties('AWS::Route53::RecordSet', {
			Type: 'A',
			Name: `${DEFAULT_DOMAIN_NAME}.`,
		})
	})

	it('does not create its own VPC or NAT gateway — imports one instead', () => {
		template.resourceCountIs('AWS::EC2::VPC', 0)
		template.resourceCountIs('AWS::EC2::NatGateway', 0)
	})

	it('honours a different domain from context', () => {
		const custom = synth({ domainName: `status-staging.${DEFAULT_HOSTED_ZONE_NAME}` })
		assert.equal(custom.config.domainName, `status-staging.${DEFAULT_HOSTED_ZONE_NAME}`)
		custom.template.hasResourceProperties('AWS::Route53::RecordSet', {
			Type: 'A',
			Name: `status-staging.${DEFAULT_HOSTED_ZONE_NAME}.`,
		})
	})
})
