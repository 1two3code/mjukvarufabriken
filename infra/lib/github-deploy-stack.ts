import { CfnOutput, Stack } from 'aws-cdk-lib'
import { CfnOIDCProvider, Effect, PolicyStatement, Role, WebIdentityPrincipal } from 'aws-cdk-lib/aws-iam'

import type { StackProps } from 'aws-cdk-lib'
import type { Construct } from 'constructs'

type GithubDeployStackProps = StackProps & {
	/** `owner/name` of the GitHub repository whose Actions may deploy */
	repository: string
	/** GitHub environment names (deploy.yml jobs) allowed to assume the role */
	environments: readonly string[]
	/** Regions the CDK stacks live in (the bootstrap roles the deploy role may assume) */
	regions: readonly string[]
}

const githubOidcHost = 'token.actions.githubusercontent.com'

/**
 * What `.github/workflows/deploy-environment.yml` authenticates with: GitHub's OIDC provider
 * registered in this account, and one deploy role it may assume — no long-lived keys. Deployed
 * ONCE per account (not per environment): `infra/scripts/deploy.sh dev github-deploy`.
 *
 * The role is deliberately thin. CDK does the actual work through the bootstrap roles
 * (`cdk-hnb659fds-{deploy,file-publishing,image-publishing,lookup}-role-*`, which the modern
 * bootstrap trusts to the account), so the deploy role only needs to ASSUME those, plus
 * `cloudformation:DescribeStacks` on `CDKToolkit` for the bootstrap guard
 * (`scripts/ensure-bootstrapped.sh`). It cannot run `cdk bootstrap` itself — a NEW account or
 * region is bootstrapped once by hand with admin credentials (TODO-EXTERNAL).
 *
 * Trust is limited to job runs of the named repository under one of the named GitHub
 * environments (`repo:<owner>/<name>:environment:<env>`), so a workflow on a branch or fork
 * without an environment binding gets nothing.
 */
export class GithubDeployStack extends Stack {
	readonly roleArn: string

	constructor(
		scope: Construct,
		id: string,
		{ repository, environments, regions, ...props }: GithubDeployStackProps
	) {
		super(scope, id, props)
		this.templateOptions.description = 'GitHub Actions OIDC provider + CDK deploy role (once per account)'
		const [owner, name] = repository.split('/')
		if (!owner || !name) throw new Error(`repository must be owner/name, got '${repository}'`)

		// GitHub's well-known thumbprints; AWS now validates the provider through its trusted CA
		// store so these are informational, but CloudFormation still accepts them.
		const provider = new CfnOIDCProvider(this, 'GithubOidcProvider', {
			url: `https://${githubOidcHost}`,
			clientIdList: ['sts.amazonaws.com'],
			thumbprintList: [
				'6938fd4d98bab03faadb97b34396831e3780aea1',
				'1c58a3a8518e8759bf075b76b750d4f2df264fcd',
			],
		})

		const role = new Role(this, 'DeployRole', {
			roleName: 'mf-github-deploy',
			description: `CDK deploy role for GitHub Actions of ${repository} (deploy.yml)`,
			assumedBy: new WebIdentityPrincipal(provider.attrArn, {
				StringEquals: { [`${githubOidcHost}:aud`]: 'sts.amazonaws.com' },
				StringLike: {
					[`${githubOidcHost}:sub`]: environments.flatMap(environment => [
						// Classic subject
						`repo:${repository}:environment:${environment}`,
						// "Immutable" subject GitHub issues for this repo (verified in CloudTrail 2026-08-30):
						// owner and name suffixed with their numeric ids, `repo:owner@123/name@456:…`
						`repo:${owner}@*/${name}@*:environment:${environment}`,
					]),
				},
			}),
		})

		role.addToPolicy(
			new PolicyStatement({
				sid: 'AssumeCdkBootstrapRoles',
				effect: Effect.ALLOW,
				actions: ['sts:AssumeRole'],
				resources: regions.map(
					region => `arn:${this.partition}:iam::${this.account}:role/cdk-*-role-${this.account}-${region}`
				),
			})
		)
		role.addToPolicy(
			new PolicyStatement({
				sid: 'BootstrapGuard',
				effect: Effect.ALLOW,
				actions: ['cloudformation:DescribeStacks'],
				resources: regions.map(
					region => `arn:${this.partition}:cloudformation:${region}:${this.account}:stack/CDKToolkit/*`
				),
			})
		)

		this.roleArn = role.roleArn
		new CfnOutput(this, 'DeployRoleArn', {
			value: role.roleArn,
			description: 'Set as the AWS_DEPLOY_ROLE_ARN secret on each GitHub environment',
		})
	}
}
