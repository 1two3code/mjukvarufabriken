import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'

import { GithubDeployStack } from '../lib/github-deploy-stack.ts'

/**
 * The OIDC trust is the security boundary of CI deploys: only job runs of OUR repository under a
 * named GitHub environment may assume the role, and the role can only hand off to the CDK
 * bootstrap roles — it never carries deploy rights of its own.
 */
describe('github-deploy stack', () => {
	const app = new App()
	const template = Template.fromStack(
		new GithubDeployStack(app, 'github-deploy', {
			repository: 'owner/name',
			environments: ['dev', 'qa', 'live'],
			regions: ['eu-north-1', 'us-east-1'],
		})
	)

	it('registers GitHub as an OIDC provider for STS', () => {
		template.hasResourceProperties('AWS::IAM::OIDCProvider', {
			Url: 'https://token.actions.githubusercontent.com',
			ClientIdList: ['sts.amazonaws.com'],
		})
	})

	it('trusts only this repository under a named environment (no branch or fork subjects)', () => {
		template.hasResourceProperties('AWS::IAM::Role', {
			RoleName: 'mf-github-deploy',
			AssumeRolePolicyDocument: {
				Statement: [
					Match.objectLike({
						Action: 'sts:AssumeRoleWithWebIdentity',
						Condition: {
							StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
							StringLike: {
								// Classic + "immutable" (id-suffixed) subject per environment
								'token.actions.githubusercontent.com:sub': [
									'repo:owner/name:environment:dev',
									'repo:owner@*/name@*:environment:dev',
									'repo:owner/name:environment:qa',
									'repo:owner@*/name@*:environment:qa',
									'repo:owner/name:environment:live',
									'repo:owner@*/name@*:environment:live',
								],
							},
						},
					}),
				],
			},
		})
	})

	it('may only assume the CDK bootstrap roles and read CDKToolkit — nothing else', () => {
		const policies = template.findResources('AWS::IAM::Policy')
		const statements = Object.values(policies).flatMap(
			policy =>
				(policy.Properties as { PolicyDocument: { Statement: unknown[] } }).PolicyDocument
					.Statement
		) as { Action: string | string[]; Resource: unknown }[]
		const actions = statements.flatMap(statement => statement.Action)
		assert.deepEqual(actions.toSorted(), ['cloudformation:DescribeStacks', 'sts:AssumeRole'])
		const json = JSON.stringify(statements)
		// Every resource is scoped (no `*`)
		assert.doesNotMatch(json, /"Resource":"\*"/)
		assert.ok(json.includes('cdk-*-role-'))
		assert.ok(json.includes('stack/CDKToolkit/*'))
		assert.ok(json.includes('us-east-1'))
	})

	it('outputs the role ARN for the GitHub secret', () => {
		template.hasOutput('DeployRoleArn', {})
	})
})
