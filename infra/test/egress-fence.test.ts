import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'

import { config } from '../lib/config.ts'
import { createRelativePath } from '../lib/helpers.ts'
import { ResourcesStack } from '../lib/resources-stack.ts'
import { WebStack } from '../lib/web-stack.ts'
import { createFakeDist, synthEnvironment } from './helpers.ts'

import type { EnvironmentConfig } from '../lib/config.ts'

/**
 * C1 hard egress fence (hardening audit 2026-08-30): behind `jobs.egressFence`, DEFAULT OFF.
 * These tests pin both sides: a normal synth is byte-compatible with the pre-fence layout
 * (sidecar proxy, 443/80-anywhere job SG, no VPC endpoints), and a fence-on synth produces the
 * deny-by-default job SG + own-task proxy + endpoints. Synth only — the flag is not deployed
 * anywhere yet; flip requirements: docs/backlog/hardening-2026-08-30/c1-egress-fence.md.
 */

const repositoryRoot = createRelativePath(import.meta.url, '../..')

const fencedEnvironment = (): EnvironmentConfig => {
	const dev = config.environments.find(env => env.name === 'dev')!
	return {
		...dev,
		jobs: { ...dev.jobs, egressFence: true, s3PrefixListId: 'pl-12345678' },
	}
}

const synthFenced = () => {
	const app = new App()
	const stack = new ResourcesStack(app, 'resources-fenced', {
		environment: fencedEnvironment(),
		repositoryRoot,
	})
	return Template.fromStack(stack)
}

/** Fenced resources + web synth, the way bin/app.ts builds them (web owns JOB_NO_PROXY) */
const synthFencedWeb = () => {
	const app = new App()
	const environment = fencedEnvironment()
	const resources = new ResourcesStack(app, 'resources-fenced', { environment, repositoryRoot })
	const web = new WebStack(app, 'mf-fenced', {
		environment,
		resources,
		siteDistPath: createFakeDist(),
		portalDistPath: createFakeDist(),
		repositoryRoot,
	})
	return Template.fromStack(web)
}

const apiEnvironmentOf = (template: Template) => {
	const taskDefinitions = template.findResources('AWS::ECS::TaskDefinition')
	const entry = Object.values(taskDefinitions).find(resource =>
		(
			resource.Properties as { ContainerDefinitions: { Environment?: { Name: string }[] }[] }
		).ContainerDefinitions.some(container =>
			(container.Environment ?? []).some(env => env.Name === 'JOB_NO_PROXY')
		)
	)
	assert.ok(entry, 'api task definition with JOB_NO_PROXY exists')
	const container = (
		entry.Properties as {
			ContainerDefinitions: { Environment?: { Name: string; Value: unknown }[] }[]
		}
	).ContainerDefinitions[0]!
	return Object.fromEntries((container.Environment ?? []).map(env => [env.Name, env.Value]))
}

const jobTaskDefinitionOf = (template: Template) => {
	const taskDefinitions = template.findResources('AWS::ECS::TaskDefinition')
	const entry = Object.entries(taskDefinitions).find(([, resource]) =>
		String((resource.Properties as { Family?: string }).Family ?? '').startsWith('mf-job-')
	)
	assert.ok(entry, 'job task definition exists')
	return entry[1].Properties as {
		ContainerDefinitions: { Name: string; Environment?: { Name: string; Value: unknown }[] }[]
	}
}

type EgressRule = {
	CidrIp?: string
	FromPort?: number
	Description?: string
	DestinationPrefixListId?: string
	DestinationSecurityGroupId?: unknown
}

/** Inline egress rules + logical id of the job SG (SG-to-SG rules synth as separate resources) */
const jobSecurityGroupOf = (template: Template) => {
	const groups = template.findResources('AWS::EC2::SecurityGroup')
	const entry = Object.entries(groups).find(
		([, resource]) =>
			(resource.Properties as { GroupDescription?: string }).GroupDescription ===
			'Build job tasks (TODO M3: egress allowlist)'
	)
	assert.ok(entry, 'job security group exists')
	const [logicalId, resource] = entry
	const properties = resource.Properties as { SecurityGroupEgress?: EgressRule[] }
	return { logicalId, inlineEgress: properties.SecurityGroupEgress ?? [] }
}

/** Every egress rule of the job SG: inline plus the separate AWS::EC2::SecurityGroupEgress ones */
const jobEgressRulesOf = (template: Template): EgressRule[] => {
	const { logicalId, inlineEgress } = jobSecurityGroupOf(template)
	const separate = Object.values(template.findResources('AWS::EC2::SecurityGroupEgress'))
		.map(resource => resource.Properties as EgressRule & { GroupId?: unknown })
		.filter(rule => JSON.stringify(rule.GroupId).includes(logicalId))
	return [...inlineEgress, ...separate]
}

describe('egress fence OFF (default) — dev synth unchanged', () => {
	const { resources } = synthEnvironment('dev')

	it('keeps the proxy as a sidecar of the job task', () => {
		const job = jobTaskDefinitionOf(resources)
		const names = job.ContainerDefinitions.map(container => container.Name).toSorted()
		assert.deepEqual(names, ['egress-proxy', 'job'])
	})

	it('points HTTP(S)_PROXY at localhost', () => {
		const job = jobTaskDefinitionOf(resources)
		const container = job.ContainerDefinitions.find(c => c.Name === 'job')!
		const env = Object.fromEntries((container.Environment ?? []).map(e => [e.Name, e.Value]))
		assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:8888')
	})

	it('leaves the job SG with 443/80-anywhere egress and creates no VPC endpoints', () => {
		const anywhere = jobEgressRulesOf(resources).filter(rule => rule.CidrIp === '0.0.0.0/0')
		assert.deepEqual(
			anywhere.map(rule => rule.FromPort).toSorted((a, b) => a! - b!),
			[80, 443]
		)
		assert.equal(Object.keys(resources.findResources('AWS::EC2::VPCEndpoint')).length, 0)
	})
})

describe('egress fence ON (synth only) — deny-by-default job SG + own-task proxy', () => {
	const template = synthFenced()

	it('runs the proxy as its own Fargate service with Cloud Map DNS', () => {
		template.hasResourceProperties('AWS::ECS::TaskDefinition', {
			Family: 'mf-egress-proxy-dev',
		})
		template.resourceCountIs('AWS::ECS::Service', 1)
		template.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', {
			Name: 'mf-dev.internal',
		})
		template.hasResourceProperties('AWS::ServiceDiscovery::Service', { Name: 'egress-proxy' })
	})

	it('removes the sidecar and points the job at the proxy service DNS', () => {
		const job = jobTaskDefinitionOf(template)
		assert.deepEqual(
			job.ContainerDefinitions.map(container => container.Name),
			['job']
		)
		const env = Object.fromEntries(
			(job.ContainerDefinitions[0]!.Environment ?? []).map(e => [e.Name, e.Value])
		)
		assert.equal(env.HTTPS_PROXY, 'http://egress-proxy.mf-dev.internal:8888')
		assert.equal(env.HTTP_PROXY, 'http://egress-proxy.mf-dev.internal:8888')
	})

	it('denies by default: the job SG has NO to-anywhere egress, only proxy/endpoints/S3', () => {
		const rules = jobEgressRulesOf(template)
		assert.equal(rules.length, 3, 'exactly proxy + endpoints + S3 prefix list')
		for (const rule of rules) {
			assert.notEqual(rule.CidrIp, '0.0.0.0/0', `no to-anywhere rule: ${rule.Description}`)
		}
		// S3 gateway prefix list on 443 (image layers + artifact uploads)
		assert.ok(
			rules.some(rule => rule.DestinationPrefixListId === 'pl-12345678'),
			'S3 prefix-list egress rule exists'
		)
		// The proxy port is the only non-443 hole
		assert.ok(
			rules.some(rule => rule.FromPort === 8888 && rule.DestinationSecurityGroupId),
			'proxy egress rule exists'
		)
	})

	it('creates interface endpoints for the NO_PROXY AWS APIs + Fargate needs, and an S3 gateway', () => {
		const endpoints = Object.values(template.findResources('AWS::EC2::VPCEndpoint'))
		const serviceNames = endpoints.map(endpoint =>
			JSON.stringify((endpoint.Properties as { ServiceName: unknown }).ServiceName)
		)
		for (const needle of [
			'secretsmanager',
			'sts',
			'.ecs',
			'codebuild',
			'logs',
			'ecr.api',
			'ecr.dkr',
			'.s3',
		]) {
			assert.ok(
				serviceNames.some(name => name.includes(needle)),
				`endpoint for ${needle} exists`
			)
		}
		const gateways = endpoints.filter(
			endpoint =>
				(endpoint.Properties as { VpcEndpointType?: string }).VpcEndpointType === 'Gateway'
		)
		assert.equal(gateways.length, 1, 'exactly one gateway endpoint (S3)')
	})

	it('gives only the proxy SG internet egress', () => {
		template.hasResourceProperties('AWS::EC2::SecurityGroup', {
			GroupDescription: 'Egress allowlist proxy for build jobs (C1) - the single way out',
			SecurityGroupEgress: Match.arrayWith([
				Match.objectLike({ CidrIp: '0.0.0.0/0', FromPort: 443 }),
				Match.objectLike({ CidrIp: '0.0.0.0/0', FromPort: 80 }),
			]),
		})
	})

	it('adds the api host to the proxy allowlist (job→api reports ride the proxy)', () => {
		template.hasResourceProperties('AWS::ECS::TaskDefinition', {
			Family: 'mf-egress-proxy-dev',
			ContainerDefinitions: Match.arrayWith([
				Match.objectLike({
					Environment: Match.arrayWith([
						Match.objectLike({
							Name: 'FILTER_ALLOW_EXTRA',
							Value: 'api.dev.mjukvaruhuset.se',
						}),
					]),
				}),
			]),
		})
	})

	it('refuses to synth without a domain — the proxy allowlist needs the api hostname', () => {
		const environment = fencedEnvironment()
		delete environment.domain
		assert.throws(
			() =>
				new ResourcesStack(new App(), 'resources-fenced-nodomain', {
					environment,
					repositoryRoot,
				}),
			/egressFence requires `domain`/
		)
	})
})

describe('egress fence and the job→api report path (web stack)', () => {
	it('fence OFF: the api host is in JOB_NO_PROXY (reports bypass the proxy, NAT → public ALB)', () => {
		const { web } = synthEnvironment('dev')
		const env = apiEnvironmentOf(web)
		assert.ok(JSON.stringify(env.JOB_NO_PROXY).includes('api.dev.mjukvaruhuset.se'))
	})

	it('fence ON: the api host is NOT in JOB_NO_PROXY — reports must ride the egress proxy', () => {
		const web = synthFencedWeb()
		const env = apiEnvironmentOf(web)
		assert.ok(!JSON.stringify(env.JOB_NO_PROXY).includes('api.dev.mjukvaruhuset.se'))
		// The url itself still points at the api domain
		assert.ok(JSON.stringify(env.JOB_API_URL).includes('api.dev.mjukvaruhuset.se'))
	})

	it('fence ON: no SG-to-SG egress rule from the job SG to the ALB (it could never match the ALB public IPs)', () => {
		const web = synthFencedWeb()
		const rules = Object.values(web.findResources('AWS::EC2::SecurityGroupEgress')).filter(
			rule => JSON.stringify((rule.Properties as { GroupId?: unknown }).GroupId).includes('JobSecurityGroup')
		)
		assert.equal(rules.length, 0, 'no egress rule is attached to the imported job SG')
	})
})
