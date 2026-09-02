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
	for (const env of ['dev', 'qa', 'live'] as const) {
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

			it('grants the job task role only the Anthropic/GitHub secrets, an artifacts-role assume, CodeBuild + ECS Express previews — no database, no direct S3', () => {
				const policies = Object.values(resources.findResources('AWS::IAM::Policy'))
				const jobPolicy = policies.find(p =>
					JSON.stringify(p.Properties).includes('JobTaskDefinitionTaskRole')
				)
				assert.ok(jobPolicy, 'job task role policy')
				const statements = (
					jobPolicy.Properties as {
						PolicyDocument: { Statement: { Action: unknown; Resource?: unknown; Condition?: unknown }[] }
					}
				).PolicyDocument.Statement
				const actions = statements.flatMap(s => (Array.isArray(s.Action) ? s.Action : [s.Action]))
				// No s3:* here — M3 hardening #1: the task role only assumes jobArtifactsRole (below),
				// which carries the scoped s3:PutObject*/Abort*; a session policy built from JOB_ID
				// narrows that further to the one job's own prefix/key at runtime (apps/job).
				// CodeBuild builds + pushes the image; ECS Express creates/inspects the preview service.
				assert.deepEqual(
					new Set(actions),
					new Set([
						'secretsmanager:GetSecretValue',
						'secretsmanager:DescribeSecret',
						'sts:AssumeRole',
						'codebuild:StartBuild',
						'codebuild:BatchGetBuilds',
						'ecs:CreateExpressGatewayService',
						'ecs:TagResource',
						'ecs:DescribeExpressGatewayService',
						'iam:PassRole',
					])
				)
				const byActions = (action: string) =>
					statements.find(s => JSON.stringify(s.Action).includes(action)) as
						{ Resource?: unknown; Condition?: unknown } | undefined
				// sts:AssumeRole is scoped to exactly jobArtifactsRole, never '*' or any other role
				const assumeRole = byActions('sts:AssumeRole')
				assert.ok(assumeRole, 'sts:AssumeRole statement')
				assert.ok(
					JSON.stringify(assumeRole.Resource).includes('JobArtifactsRole'),
					'sts:AssumeRole must target jobArtifactsRole'
				)
				assert.ok(
					!JSON.stringify(assumeRole.Resource).includes('"*"'),
					'sts:AssumeRole must not be account/role-wide'
				)
				// Two secrets only — the Anthropic key and (M5) the GitHub token; never the RDS master
				// secret, Stripe or the auth signing key
				const secretStatements = statements.filter(s =>
					JSON.stringify(s.Action).includes('secretsmanager')
				)
				assert.equal(secretStatements.length, 2)
				assert.ok(
					!JSON.stringify(secretStatements).match(/stripe|authjwt/i),
					'job role must not read Stripe or auth secrets'
				)
				assert.ok(
					!JSON.stringify(jobPolicy.Properties).includes('DatabaseSecret'),
					'job task role must not reference the database secret'
				)
				// The job never touches ECR directly — CodeBuild does the build + push
				assert.ok(!JSON.stringify(actions).includes('ecr:'), 'job role must not call ECR directly')
				// ECS Express: only services tagged `Service=mf-delivery` (created by the job itself)
				assert.deepEqual(byActions('ecs:CreateExpressGatewayService')?.Condition, {
					StringEquals: { 'aws:RequestTag/Service': 'mf-delivery' },
				})
				assert.deepEqual(byActions('ecs:DescribeExpressGatewayService')?.Condition, {
					StringEquals: { 'aws:ResourceTag/Service': 'mf-delivery' },
				})
				// CodeBuild is resource-scoped to the single delivery project, never account-wide
				const codeBuild = byActions('codebuild:StartBuild')
				assert.ok(codeBuild, 'codebuild statement')
				assert.ok(
					!JSON.stringify(codeBuild.Resource).includes('"*"'),
					'codebuild must be scoped to the delivery project'
				)
				// PassRole: the two Express roles to ECS, the CodeBuild role to CodeBuild — never '*'
				const passRoles = statements.filter(
					s => JSON.stringify(s.Action) === JSON.stringify('iam:PassRole')
				) as { Resource: unknown; Condition: { StringEquals: Record<string, unknown> } }[]
				assert.equal(passRoles.length, 3)
				// …and the per-app preview role (minted by the api, passed by the job) to ECS tasks only
				const previewPass = passRoles.find(s =>
					JSON.stringify(s.Resource).includes('mf-preview-app-*')
				)
				assert.ok(previewPass, 'the job passes preview app roles (it creates the Express service)')
				assert.equal(previewPass.Condition.StringEquals['iam:PassedToService'], 'ecs-tasks.amazonaws.com')
				const passedServices = passRoles.flatMap(s => {
					const value = s.Condition.StringEquals['iam:PassedToService']
					return Array.isArray(value) ? value : [value]
				})
				assert.deepEqual(
					new Set(passedServices),
					new Set(['ecs-tasks.amazonaws.com', 'ecs.amazonaws.com', 'codebuild.amazonaws.com'])
				)
				for (const passRole of passRoles) {
					assert.ok(
						!JSON.stringify(passRole.Resource).includes('"*"'),
						'PassRole must be scoped to specific roles'
					)
				}
			})

			it('scopes jobArtifactsRole to deliverables/* + delivery-source/* only, assumable only by the job task role (M3 hardening #1)', () => {
				const roles = Object.values(resources.findResources('AWS::IAM::Role')) as {
					Properties: { RoleName?: string; AssumeRolePolicyDocument?: unknown }
				}[]
				const artifactsRole = roles.find(r => r.Properties.RoleName === `mf-job-artifacts-${env}`)
				assert.ok(artifactsRole, 'jobArtifactsRole')
				assert.ok(
					JSON.stringify(artifactsRole.Properties.AssumeRolePolicyDocument).includes(
						'JobTaskDefinitionTaskRole'
					),
					'jobArtifactsRole must trust only the job task role'
				)
				assert.ok(
					!/ecs-tasks\.amazonaws\.com|ecs\.amazonaws\.com/.test(
						JSON.stringify(artifactsRole.Properties.AssumeRolePolicyDocument)
					),
					'jobArtifactsRole must not be directly assumable by an ECS service principal'
				)
				// Keyed by logical id (not JSON.stringify-includes — the job task role's own policy
				// also mentions "JobArtifactsRole" in its sts:AssumeRole Resource ARN)
				const artifactsPolicy = Object.entries(resources.findResources('AWS::IAM::Policy')).find(
					([logicalId]) => logicalId.startsWith('JobArtifactsRoleDefaultPolicy')
				)?.[1]
				assert.ok(artifactsPolicy, 'jobArtifactsRole policy')
				const statements = (
					artifactsPolicy.Properties as {
						PolicyDocument: { Statement: { Action: unknown; Resource?: unknown }[] }
					}
				).PolicyDocument.Statement
				const actions = statements.flatMap(s => (Array.isArray(s.Action) ? s.Action : [s.Action]))
				// Same grantPut action set as before — upload only, never delete or overwrite-by-delete
				assert.deepEqual(
					new Set(actions),
					new Set([
						's3:PutObject',
						's3:PutObjectLegalHold',
						's3:PutObjectRetention',
						's3:PutObjectTagging',
						's3:PutObjectVersionTagging',
						's3:Abort*',
					])
				)
				// Ceiling is the two delivery prefixes, never the bucket root/wildcard — the per-job
				// narrowing to deliverables/<jobId>/* + delivery-source/<jobId>.zip happens at runtime
				// via the session policy the job builds from its own JOB_ID.
				const resourceStrings = JSON.stringify(statements.flatMap(s => s.Resource))
				assert.ok(resourceStrings.includes('deliverables/*'))
				assert.ok(resourceStrings.includes('delivery-source/*'))
				assert.ok(
					!/"\*"|"arn:aws:s3:::[^/"]+"/.test(resourceStrings),
					'jobArtifactsRole must not have bucket-root or bucket-wide access'
				)
			})

			// EC2 rejects security-group rule descriptions containing characters outside its allowed
			// set, and `cdk synth` does not validate them — so a stray character is only discovered
			// when CloudFormation tries to create the rule and the whole stack rolls back. That cost
			// a dev deploy on 2026-09-01 (an arrow in 'load balancer -> app'). Cheap to pin here.
			it('uses only characters EC2 accepts in security-group rule descriptions', () => {
				const allowed = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]*$/
				const descriptions = [
					...Object.values(resources.findResources('AWS::EC2::SecurityGroup')).flatMap(group => [
						...((group.Properties?.SecurityGroupIngress ?? []) as { Description?: string }[]),
						...((group.Properties?.SecurityGroupEgress ?? []) as { Description?: string }[]),
					]),
					...Object.values(resources.findResources('AWS::EC2::SecurityGroupIngress')).map(
						rule => rule.Properties ?? {}
					),
					...Object.values(resources.findResources('AWS::EC2::SecurityGroupEgress')).map(
						rule => rule.Properties ?? {}
					),
				]
					.map(rule => (rule as { Description?: string }).Description)
					.filter((text): text is string => typeof text === 'string')

				assert.ok(descriptions.length > 0, 'some rule descriptions exist')
				for (const text of descriptions) {
					assert.ok(allowed.test(text), `rejected by EC2: ${JSON.stringify(text)}`)
				}
			})

			// The delivered app reaches its own provisioned database through a security group WE own
			// (passed to CreateExpressGatewayService as networkConfiguration), never by opening 5432
			// to the VPC. That distinction is the whole point: a VPC-wide rule would also have handed
			// database access to the BUILD JOB, undoing the M3 invariant the test above pins.
			it('lets only the preview-app security group reach the database, never the job', () => {
				const rules = Object.values(resources.findResources('AWS::EC2::SecurityGroupIngress'))
					.map(rule => rule.Properties ?? {})
					.filter((rule: { FromPort?: number }) => rule.FromPort === 5432)
				assert.ok(rules.length > 0, 'a 5432 ingress rule exists')
				for (const rule of rules as { CidrIp?: string; SourceSecurityGroupId?: unknown }[]) {
					assert.equal(rule.CidrIp, undefined, '5432 must never be opened to a CIDR range')
					assert.ok(rule.SourceSecurityGroupId, '5432 ingress must reference a security group')
				}
			})

			// The api mints one IAM role per delivered app (docs/PREVIEW-RESOURCES.md). Giving a
			// service IAM-write is only safe while the fence holds, and the load-bearing part is the
			// `iam:PermissionsBoundary` condition on CreateRole: without it the api could mint a role
			// with any policy at all, which is a straight path from "api compromise" to "account
			// compromise". Name/path scoping alone would NOT be enough.
			it('fences the api iam:CreateRole grant to boundary-carrying preview roles only', () => {
				const statements = Object.values(web.findResources('AWS::IAM::Policy'))
					.flatMap(policy => policy.Properties?.PolicyDocument?.Statement ?? [])
					.filter((statement: { Action?: unknown }) => {
						const actions = [statement.Action ?? []].flat()
						return actions.includes('iam:CreateRole')
					})
				assert.equal(statements.length, 1, 'exactly one grant may create IAM roles')
				const create = statements[0] as {
					Resource: unknown
					Condition?: Record<string, Record<string, unknown>>
				}
				// Scoped to the preview role name AND path
				const resource = JSON.stringify(create.Resource)
				assert.ok(resource.includes('mf-preview-app-*'), 'CreateRole scoped to the preview name')
				assert.ok(resource.includes('mf-preview'), 'CreateRole scoped to the preview path')
				assert.ok(!resource.includes('"*"'), 'CreateRole must never be unscoped')
				// …and, crucially, refused unless the minted role carries the boundary
				const boundary = create.Condition?.StringEquals?.['iam:PermissionsBoundary']
				assert.ok(boundary, 'CreateRole must require a permissions boundary')
			})

			// The boundary condition is load-bearing for CreateRole and FATAL for anything else:
			// `iam:PermissionsBoundary` is a condition key only CreateRole (and the boundary calls)
			// supply. Any other action in that statement is a grant that never matches. Dogfood run 7
			// (2026-09-02) put `iam:TagRole` there — CreateRole-with-tags then failed on its implicit
			// TagRole with AccessDenied, after every gate had passed, and the deploy was lost. The
			// pre-deploy IAM simulation had only asked about CreateRole, so it said "allowed".
			it('keeps every action other than CreateRole out of the boundary-conditioned grant', () => {
				const conditioned = Object.values(web.findResources('AWS::IAM::Policy'))
					.flatMap(policy => policy.Properties?.PolicyDocument?.Statement ?? [])
					.filter(
						(statement: { Condition?: Record<string, Record<string, unknown>> }) =>
							statement.Condition?.StringEquals?.['iam:PermissionsBoundary'] !== undefined
					)
				assert.ok(conditioned.length > 0, 'the boundary-conditioned grant exists')
				for (const statement of conditioned as { Action?: unknown }[]) {
					assert.deepEqual(
						[statement.Action ?? []].flat(),
						['iam:CreateRole'],
						'only iam:CreateRole evaluates the iam:PermissionsBoundary key — anything else here silently never matches'
					)
				}
				// …while TagRole (the implicit second call of CreateRole-with-tags) IS granted, unconditioned
				const tag = Object.values(web.findResources('AWS::IAM::Policy'))
					.flatMap(policy => policy.Properties?.PolicyDocument?.Statement ?? [])
					.filter((statement: { Action?: unknown }) =>
						[statement.Action ?? []].flat().includes('iam:TagRole')
					) as { Resource: unknown; Condition?: unknown }[]
				assert.equal(tag.length, 1, 'exactly one grant tags preview roles')
				assert.equal(tag[0]!.Condition, undefined, 'TagRole must not carry the boundary condition')
				assert.ok(JSON.stringify(tag[0]!.Resource).includes('mf-preview-app-*'), 'TagRole scoped to preview roles')
			})

			// PassRole is how a PassRole grant turns into privilege escalation: without a service
			// condition, anything that can pass a role can hand it to a service of its choosing.
			// The api mints preview roles but never passes them — the job does, when it creates the
			// Express service (asserted on the job task role above). A PassRole here would be an
			// unused grant on the internet-facing principal, and the first redelivery (4922e82d,
			// 2026-09-02) showed the grant had been sitting on this wrong principal all along.
			it('gives the api no iam:PassRole on preview roles at all', () => {
				const statements = Object.values(web.findResources('AWS::IAM::Policy'))
					.flatMap(policy => policy.Properties?.PolicyDocument?.Statement ?? [])
					.filter((statement: { Action?: unknown }) =>
						[statement.Action ?? []].flat().includes('iam:PassRole')
					)
				const previewPass = statements.filter((statement: { Resource?: unknown }) =>
					JSON.stringify(statement.Resource ?? '').includes('mf-preview-app-*')
				)
				assert.equal(previewPass.length, 0, 'the api must not hold PassRole on preview roles')
			})

			// Mirror of the assertion above for the OTHER principal that touches the artifacts bucket.
			// The delivery CodeBuild project is `privileged: true` and builds apps/api/Dockerfile out of
			// an AI-authored repo, so its service role must never see another job's deliverables. An
			// unscoped `artifactsBucket.grantRead(deliveryBuildProject)` (objectsKeyPattern defaults to
			// '*') did exactly that until the 2026-08-31 audit (P0-1).
			it('scopes the delivery CodeBuild role to delivery-source/* — never the whole artifacts bucket', () => {
				const policy = Object.entries(resources.findResources('AWS::IAM::Policy')).find(
					([logicalId]) => logicalId.startsWith('DeliveryBuildProjectRoleDefaultPolicy')
				)?.[1]
				assert.ok(policy, 'DeliveryBuildProject role policy')
				const statements = (
					policy.Properties as {
						PolicyDocument: { Statement: { Action: unknown; Resource?: unknown }[] }
					}
				).PolicyDocument.Statement
				const s3Statements = statements.filter(s =>
					(Array.isArray(s.Action) ? s.Action : [s.Action]).some(
						action => typeof action === 'string' && action.startsWith('s3:')
					)
				)
				assert.ok(s3Statements.length > 0, 'expected an s3 grant for the CodeBuild S3 source')
				const resourceStrings = JSON.stringify(s3Statements.flatMap(s => s.Resource))
				// The prefixed grant must survive — CodeBuild has to read delivery-source/<jobId>.zip
				assert.ok(
					resourceStrings.includes('/delivery-source/*'),
					'the delivery-source prefix must stay readable (the S3 source of the build)'
				)
				// …but nothing bucket-wide. The bare bucket ARN is fine (s3:GetBucket*/s3:List* need it);
				// an object wildcard under it is not — that is `deliverables/<jobId>/` of every job.
				assert.ok(
					!/"\*"|"\/\*"/.test(resourceStrings),
					'delivery CodeBuild role must not read the artifacts bucket object-wide'
				)
			})

			it('gives the ECS Express preview roles only their managed policies (no inline grants)', () => {
				const roles = Object.values(resources.findResources('AWS::IAM::Role')) as {
					Properties: {
						RoleName?: string
						AssumeRolePolicyDocument?: unknown
						Policies?: unknown
						ManagedPolicyArns?: unknown
					}
				}[]
				const execRole = roles.find(r => r.Properties.RoleName === `mf-express-execution-${env}`)
				const infraRole = roles.find(r => r.Properties.RoleName === `mf-express-infra-${env}`)
				assert.ok(execRole, 'express execution role')
				assert.ok(infraRole, 'express infrastructure role')
				// Assumed by the right service principals
				assert.ok(
					JSON.stringify(execRole.Properties.AssumeRolePolicyDocument).includes(
						'ecs-tasks.amazonaws.com'
					)
				)
				assert.ok(
					JSON.stringify(infraRole.Properties.AssumeRolePolicyDocument).includes('ecs.amazonaws.com')
				)
				// Only the managed policies, no hand-written inline policies (the preview api needs no AWS access)
				assert.equal(execRole.Properties.Policies, undefined)
				assert.equal(infraRole.Properties.Policies, undefined)
				assert.ok(
					JSON.stringify(execRole.Properties.ManagedPolicyArns).includes(
						'AmazonECSTaskExecutionRolePolicy'
					)
				)
				assert.ok(
					JSON.stringify(infraRole.Properties.ManagedPolicyArns).includes(
						// service-role/, capital "For" — the ECS docs' lowercase "for" 404s in IAM
						// (resources-stack.ts, fixed in 18fd39b); the assertion must track the real ARN.
						'AmazonECSInfrastructureRoleForExpressGatewayServices'
					)
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
				// The invariant is that the JOB cannot reach postgres — not that no 5432 rule exists at
				// all. Since docs/PREVIEW-RESOURCES.md, delivered preview apps legitimately reach
				// their OWN provisioned database through their own security group, so the assertion
				// names the job's group rather than counting rules. Widening this to a CIDR would
				// silently readmit the job; the neighbouring test forbids exactly that.
				const jobGroup = Object.entries(resources.findResources('AWS::EC2::SecurityGroup')).find(
					([logicalId]) => logicalId.startsWith('JobSecurityGroup')
				)?.[0]
				assert.ok(jobGroup, 'job security group')
				const postgresRules = rules.filter(
					r => (r.Properties as { FromPort?: number }).FromPort === 5432
				)
				const reachableByJob = postgresRules.filter(r => {
					const props = r.Properties as { CidrIp?: string; SourceSecurityGroupId?: unknown }
					// A CIDR rule covers the whole VPC, and the job is in it
					if (props.CidrIp) return true
					return JSON.stringify(props.SourceSecurityGroupId ?? '').includes(jobGroup)
				})
				assert.equal(reachableByJob.length, 0, 'no job <-> postgres reachability on 5432')
				const apiEnv = containersOf(web)
					.flatMap(c => c.Environment ?? [])
					.map(e => e.Name)
				assert.ok(apiEnv.includes('JOB_API_URL') && apiEnv.includes('JOB_NO_PROXY'))
			})

			it('scopes the api task role’s cloudwatch:PutMetricData to its own mf/<env> namespace (M3 hardening #2)', () => {
				const policies = Object.values(web.findResources('AWS::IAM::Policy'))
				const apiPolicy = policies.find(p => JSON.stringify(p.Properties).includes('ApiTaskDefTaskRole'))
				assert.ok(apiPolicy, 'api task role policy')
				const statements = (
					apiPolicy.Properties as {
						PolicyDocument: { Statement: { Action: unknown; Condition?: unknown }[] }
					}
				).PolicyDocument.Statement
				const putMetric = statements.find(
					s => JSON.stringify(s.Action).includes('cloudwatch:PutMetricData')
				) as { Condition?: { StringEquals?: Record<string, unknown> } } | undefined
				assert.ok(putMetric, 'cloudwatch:PutMetricData statement')
				assert.deepEqual(putMetric?.Condition, {
					StringEquals: { 'cloudwatch:namespace': `mf/${env}` },
				})
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
