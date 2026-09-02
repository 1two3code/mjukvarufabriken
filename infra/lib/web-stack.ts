import { Annotations, CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager'
import {
	AllowedMethods,
	CachePolicy,
	Distribution,
	HeadersFrameOption,
	HeadersReferrerPolicy,
	OriginProtocolPolicy,
	OriginRequestPolicy,
	ResponseHeadersPolicy,
	SecurityPolicyProtocol,
	ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront'
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins'
import { Port, SecurityGroup, SubnetType } from 'aws-cdk-lib/aws-ec2'
import { Cluster, ContainerImage, LogDrivers } from 'aws-cdk-lib/aws-ecs'
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns'
import { ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import { PolicyStatement } from 'aws-cdk-lib/aws-iam'
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs'
import { ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53'
import { CloudFrontTarget, LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets'
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3'
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment'

import type { StackProps } from 'aws-cdk-lib'
import type { IHostedZone } from 'aws-cdk-lib/aws-route53'
import type { Construct } from 'constructs'
import type { EnvironmentConfig } from './config.ts'
import type { ResourcesStack } from './resources-stack.ts'

export interface WebStackProps extends StackProps {
	environment: EnvironmentConfig
	resources: ResourcesStack
	/** Absolute path to the built public site (apps/site/dist/<env>) */
	siteDistPath: string
	/** Absolute path to the built customer portal (apps/portal/dist/<env>) */
	portalDistPath: string
	/** Absolute path to the repository root (Docker build context) */
	repositoryRoot: string
}

export class WebStack extends Stack {
	/** The api service (ALB + target group + Fargate service) — alarms live in OpsStack */
	readonly api: ApplicationLoadBalancedFargateService
	/** `/mf/<env>/api` — pino JSON lines from the api container (see docs/RUNBOOK.md) */
	readonly apiLogGroup: LogGroup

	constructor(scope: Construct, id: string, props: WebStackProps) {
		super(scope, id, props)

		const { environment, resources, siteDistPath, portalDistPath, repositoryRoot } = props
		const { domain } = environment
		const isLive = environment.name === 'live'

		const hostedZone: IHostedZone | undefined = domain
			? HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
					hostedZoneId: domain.hostedZoneId,
					zoneName: domain.hostedZoneName,
				})
			: undefined

		// MARK: SPAs — S3 + CloudFront, one pair per app. Security headers (M9 baseline): HSTS,
		// X-Content-Type-Options nosniff, X-Frame-Options DENY + CSP frame-ancestors 'none' (nothing
		// may frame the portal or the site), strict referrer policy.
		const responseHeadersPolicy = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
			securityHeadersBehavior: {
				contentTypeOptions: { override: true },
				contentSecurityPolicy: {
					contentSecurityPolicy:
						"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https: http:",
					override: true,
				},
				referrerPolicy: {
					referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
					override: true,
				},
				frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
				strictTransportSecurity: {
					accessControlMaxAge: Duration.days(365),
					includeSubdomains: true,
					override: true,
				},
			},
		})

		const cloudFrontCertificate = domain
			? Certificate.fromCertificateArn(this, 'SpaCertificate', domain.cloudFrontCertificateArn)
			: undefined

		const createSpa = (id: string, distPath: string, domainName?: string) => {
			const bucket = new Bucket(this, `${id}Bucket`, {
				blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
				removalPolicy: isLive ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
				autoDeleteObjects: !isLive,
			})

			const distribution = new Distribution(this, `${id}Distribution`, {
				defaultRootObject: 'index.html',
				defaultBehavior: {
					origin: S3BucketOrigin.withOriginAccessControl(bucket),
					viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
					allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
					responseHeadersPolicy,
				},
				// SPA fallback: let the client router handle unknown paths
				errorResponses: [
					{ httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
					{ httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
				],
				...(domainName &&
					cloudFrontCertificate && {
						domainNames: [domainName],
						certificate: cloudFrontCertificate,
						// Explicit, not inherited (audit 2026-08-31, P0-5). Left out, CDK derives the TLS
						// floor from the `@aws-cdk/aws-cloudfront:defaultSecurityPolicyTLSv1.2_2021`
						// feature flag — and infra/cdk.json sets no feature flags at all, so the security
						// policy of every domain we serve would hang off a CDK default we do not control
						// (TLS_V1_2_2019 with the flag off, which still negotiates the 2019 cipher set).
						// Only meaningful alongside a certificate: CloudFront fixes the default
						// *.cloudfront.net certificate at its own policy and CDK warns if we set it anyway.
						minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
					}),
			})

			new BucketDeployment(this, `${id}Deployment`, {
				sources: [Source.asset(distPath)],
				destinationBucket: bucket,
				distribution,
				distributionPaths: ['/*'],
			})

			const url = domainName
				? `https://${domainName}`
				: `https://${distribution.distributionDomainName}`

			return { distribution, url }
		}

		const site = createSpa('Site', siteDistPath, domain?.siteDomainName)
		const portal = createSpa('Portal', portalDistPath, domain?.portalDomainName)

		// MARK: API — ECS Fargate behind an ALB
		const cluster = new Cluster(this, 'Cluster', { vpc: resources.vpc })
		// Build jobs run in the private (NAT) subnets; the api passes these to ecs:RunTask
		const jobSubnets = resources.vpc.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS })

		const apiUrl = domain ? `https://${domain.apiDomainName}` : undefined

		this.apiLogGroup = new LogGroup(this, 'ApiLogGroup', {
			logGroupName: `/mf/${environment.name}/api`,
			retention: isLive ? RetentionDays.ONE_MONTH : RetentionDays.TWO_WEEKS,
			removalPolicy: isLive ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
		})

		const api = new ApplicationLoadBalancedFargateService(this, 'Api', {
			cluster,
			cpu: 512,
			memoryLimitMiB: 1024,
			desiredCount: isLive ? 2 : 1,
			minHealthyPercent: 50,
			circuitBreaker: { rollback: true },
			publicLoadBalancer: true,
			...(domain && {
				protocol: ApplicationProtocol.HTTPS,
				redirectHTTP: true,
				certificate: Certificate.fromCertificateArn(
					this,
					'ApiCertificate',
					domain.apiCertificateArn
				),
			}),
			taskImageOptions: {
				image: ContainerImage.fromAsset(repositoryRoot, { file: 'apps/api/Dockerfile' }),
				containerPort: 80,
				logDriver: LogDrivers.awsLogs({ logGroup: this.apiLogGroup, streamPrefix: 'api' }),
				// Only ARNs and non-secret settings here — every credential is read from Secrets
				// Manager at start-up by the `secrets` plugin (M9 baseline: no plaintext secrets in
				// task definitions; infra/test/security-baseline.test.ts enforces it).
				environment: {
					ENV: environment.name,
					LOG_LEVEL: isLive ? 'warn' : 'info',
					SITE_URL: site.url,
					PORTAL_URL: portal.url,
					AUTH_AUDIENCE: environment.auth.audience,
					AUTH_JWT_PRIVATE_KEY_SECRET_ARN: resources.secrets['auth-jwt-private-key'].secretArn,
					AUTH_ADMIN_EMAILS: environment.adminEmails.join(','),
					AUTH_EMAIL_FROM: environment.email.from,
					EMAIL_TRANSPORT: environment.email.transport,
					DATABASE_SECRET_ARN: resources.databaseSecret.secretArn,
					ARTIFACTS_BUCKET: resources.artifactsBucket.bucketName,
					// Per-delivery preview storage: the bucket delivered apps write into, and the
					// boundary every minted per-app role must carry (the api's own IAM grant is
					// conditioned on it, so a role created without it is refused by IAM, not by us)
					PREVIEW_BUCKET: resources.previewBucket.bucketName,
					PREVIEW_ROLE_BOUNDARY_ARN: resources.previewRoleBoundary.managedPolicyArn,
					AWS_ACCOUNT_ID: Stack.of(this).account,
					JOBS_CLUSTER_ARN: resources.jobsCluster.clusterArn,
					// Family, not ARN: RunTask resolves the latest revision and there is no cross-stack
					// export that changes on every job image rebuild
					JOB_TASK_DEFINITION_ARN: resources.jobTaskDefinition.family,
					JOB_SUBNET_IDS: jobSubnets.subnetIds.join(','),
					JOB_SECURITY_GROUP_ID: resources.jobSecurityGroup.securityGroupId,
					ANTHROPIC_API_KEY_SECRET_ARN: resources.secrets['anthropic-api-key'].secretArn,
					STRIPE_SECRET_KEY_SECRET_ARN: resources.secrets['stripe-secret-key'].secretArn,
					STRIPE_WEBHOOK_SECRET_SECRET_ARN: resources.secrets['stripe-webhook-secret'].secretArn,
					GITHUB_OAUTH_CLIENT_SECRET_SECRET_ARN:
						resources.secrets['github-oauth-client-secret'].secretArn,
					// Error tracking (M9 follow-up): empty placeholder until a Sentry project exists
					// (TODO-EXTERNAL) — the api's `sentry` plugin decorates an inert client until then
					SENTRY_DSN_SECRET_ARN: resources.secrets['sentry-dsn'].secretArn,
					// The client id is public; only with it does the api enable the GitHub sign-in routes
					...(environment.githubOAuth && {
						GITHUB_OAUTH_CLIENT_ID: environment.githubOAuth.clientId,
					}),
				},
			},
			// Private subnets with NAT: can reach RDS (isolated subnets in the same VPC) and the internet
			taskSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
		})
		api.targetGroup.configureHealthCheck({ path: '/health', interval: Duration.seconds(30) })
		this.api = api
		// The issuer is the api's own URL; without a custom domain it is only known after synth
		const albUrl = `http://${api.loadBalancer.loadBalancerDnsName}`
		api.taskDefinition.defaultContainer!.addEnvironment(
			'AUTH_ISSUER',
			environment.auth.issuer ?? apiUrl ?? albUrl
		)
		// Build jobs report to the api (M3 hardening): the url plus — fence off — the host the
		// job's NO_PROXY must bypass the egress proxy for. Both go to the job task through the
		// api's RunTask override — the task definition lives in the resources stack, which cannot
		// reference this ALB. Fence OFF: the job SG allows 443/80 egress anywhere and the public
		// ALB accepts 80/443 from anywhere, so the reports arrive through the NAT gateway with no
		// extra rule. Fence ON (C1): the job SG is deny-by-default, and NO security-group rule can
		// open the NAT path back up — an egress rule that references the ALB's SG only matches
		// traffic addressed to the ALB ENIs' PRIVATE IPs, while `jobApiHost` (the api domain or
		// the ALB DNS name of an internet-facing ALB) resolves to its PUBLIC IPs, so such a rule
		// is dead weight and the reports would be dropped at the job ENI. Instead the reports ride
		// the egress proxy like all other internet traffic: the api host is NOT put in NO_PROXY
		// (below) and the proxy's allowlist admits it (`FILTER_ALLOW_EXTRA` on the proxy service,
		// resources-stack — which is also why the fence requires `domain`: the ALB DNS name is not
		// known to that stack). Route: job → proxy SG → NAT → public ALB, TLS end-to-end (CONNECT).
		const jobApiHost = domain ? domain.apiDomainName : api.loadBalancer.loadBalancerDnsName
		if (!apiUrl) {
			// The ALB only terminates TLS with the domain's certificate; until then the per-job
			// bearer token crosses NAT → public ALB in cleartext (certificate: TODO-EXTERNAL.md)
			Annotations.of(this).addWarningV2(
				'mf:job-api-url-http',
				`JOB_API_URL is plain http (${albUrl}) — configure \`domain\` so build jobs report over TLS`
			)
		}
		api.taskDefinition.defaultContainer!.addEnvironment('JOB_API_URL', apiUrl ?? albUrl)
		api.taskDefinition.defaultContainer!.addEnvironment(
			'JOB_NO_PROXY',
			// Fence on: the api host must go THROUGH the proxy (the deny-by-default job SG has no
			// route to the ALB's public IPs) — so it must not be in NO_PROXY. See the comment above.
			(environment.jobs.egressFence
				? resources.jobNoProxyHosts
				: [...resources.jobNoProxyHosts, jobApiHost]
			).join(',')
		)

		// MARK: Api task role — least privilege (reviewed M9). What each grant is for:
		//   secretsmanager:GetSecretValue on the RDS secret     — Postgres connection (DATABASE_SECRET_ARN)
		//   ... on anthropic-api-key                            — spec chat (M2 spec engine runs in the api)
		//   ... on auth-jwt-private-key                         — signs access tokens (EdDSA issuer)
		//   ... on stripe-secret-key / stripe-webhook-secret    — checkout + webhook verification (M6)
		//   ... on github-oauth-client-secret                  — "Sign in with GitHub" code exchange (M6)
		//   ... on sentry-dsn                                  — error tracking (SaaS, free tier)
		//   s3 read/write on the artifacts bucket               — presigned deliverable downloads, uploads
		//   ses:SendEmail on the domain identity                — magic-link mail (only with a domain)
		//   ecs:RunTask (job family, jobs cluster only)         — start a build job
		//   ecs:DescribeTasks/StopTask/ListTasks (jobs cluster) — job status + admin kill switch
		//   iam:PassRole on the job task + execution roles      — required by RunTask
		//   cloudwatch:PutMetricData (mf/<env> namespace only)  — tamper-proof jobs-failed/job-token-burn
		//     alarms (M3 hardening #2, infra/lib/ops-stack.ts), published from the trusted job report
		//     write, not the job container's own log lines
		// Not granted: github-app-key raw (only via the delivery secret grant), logs:* (execution role), any
		// wildcard on secrets or buckets.
		const taskRole = api.taskDefinition.taskRole
		resources.databaseSecret.grantRead(taskRole)
		resources.secrets['anthropic-api-key'].grantRead(taskRole)
		resources.secrets['auth-jwt-private-key'].grantRead(taskRole)
		resources.secrets['stripe-secret-key'].grantRead(taskRole)
		resources.secrets['stripe-webhook-secret'].grantRead(taskRole)
		resources.secrets['github-oauth-client-secret'].grantRead(taskRole)
		resources.secrets['sentry-dsn'].grantRead(taskRole)
		resources.artifactsBucket.grantReadWrite(taskRole)

		// Magic-link emails. With a verified domain identity the grant is scoped to it; without one
		// (no `domain` config) SES is not set up and the api runs the `log` transport instead.
		if (resources.emailIdentity) {
			resources.emailIdentity.grantSendEmail(taskRole)
		}

		// api → Postgres. The ingress rule is created in this stack (on an imported view of the
		// database security group) so the resources stack never depends on this one.
		const databaseSecurityGroup = SecurityGroup.fromSecurityGroupId(
			this,
			'DatabaseSecurityGroup',
			resources.databaseSecurityGroup.securityGroupId,
			{ mutable: true }
		)
		databaseSecurityGroup.addIngressRule(
			api.service.connections.securityGroups[0]!,
			Port.tcp(5432),
			'api to postgres'
		)

		// Start/inspect/stop build jobs on the jobs cluster (M3)
		const { jobTaskDefinition, jobsCluster } = resources
		taskRole.addToPrincipalPolicy(
			new PolicyStatement({
				actions: ['ecs:RunTask'],
				resources: [
					this.formatArn({
						service: 'ecs',
						resource: 'task-definition',
						resourceName: `${jobTaskDefinition.family}:*`,
					}),
				],
				conditions: { ArnEquals: { 'ecs:cluster': jobsCluster.clusterArn } },
			})
		)
		taskRole.addToPrincipalPolicy(
			new PolicyStatement({
				actions: ['ecs:DescribeTasks', 'ecs:StopTask', 'ecs:ListTasks'],
				resources: ['*'],
				conditions: { ArnEquals: { 'ecs:cluster': jobsCluster.clusterArn } },
			})
		)
		jobTaskDefinition.taskRole.grantPassRole(taskRole)
		jobTaskDefinition.obtainExecutionRole().grantPassRole(taskRole)

		// Tamper-proof alarm metrics (M3 hardening #2, infra/lib/ops-stack.ts): the api publishes
		// JobsFailed/JobTokensUsed from its own trusted, Zod-validated job report ingestion — never
		// from the build container's raw log lines, which a customer's build script can also print.
		// PutMetricData has no ARN to scope (Resource must be '*'); the namespace condition is the
		// only fence CloudWatch offers, so the api can publish only into its own `mf/<env>` namespace.
		taskRole.addToPrincipalPolicy(
			new PolicyStatement({
				actions: ['cloudwatch:PutMetricData'],
				resources: ['*'],
				conditions: { StringEquals: { 'cloudwatch:namespace': `mf/${environment.name}` } },
			})
		)

		// Per-delivery preview storage (docs/PREVIEW-RESOURCES.md). The api mints one small IAM role
		// per delivered app, scoped to that app's own prefix. Giving the api IAM-write is the price
		// of real (IAM-enforced, not convention-enforced) isolation between delivered apps, so the
		// grant is fenced four ways:
		//   1. name    — only roles called `mf-preview-app-*`
		//   2. path    — only under `/mf-preview/`, which nothing else in the account uses
		//   3. boundary— `iam:PermissionsBoundary` MUST equal the preview boundary policy, so a
		//                minted role can never hold more than "objects in the preview bucket";
		//                without this condition the whole fence is decorative
		//   4. actions — create/read/tag and inline-policy writes only; no attach of managed
		//                policies, no boundary edits, no role deletion outside the path
		const previewRoleArn = `arn:aws:iam::${Stack.of(this).account}:role/mf-preview/mf-preview-app-*`
		taskRole.addToPrincipalPolicy(
			new PolicyStatement({
				sid: 'MintPreviewAppRoles',
				// ONLY CreateRole may sit under the boundary condition: `iam:PermissionsBoundary` is a
				// condition key CreateRole supplies and TagRole does not, so a TagRole grant placed here
				// is a grant that never matches — CreateRole-with-tags then fails on its implicit
				// TagRole with AccessDenied. That is exactly how dogfood run 7 (2026-09-02) lost its
				// deploy after every gate had passed. TagRole lives in the scoped statement below.
				actions: ['iam:CreateRole'],
				resources: [previewRoleArn],
				conditions: {
					StringEquals: {
						'iam:PermissionsBoundary': resources.previewRoleBoundary.managedPolicyArn,
					},
				},
			})
		)
		taskRole.addToPrincipalPolicy(
			new PolicyStatement({
				sid: 'ScopePreviewAppRoles',
				// PutRolePolicy is the prefix scoping itself; GetRole is the redelivery path; TagRole is
				// the implicit second call of CreateRole-with-tags. None of them can widen the role
				// beyond the boundary attached at creation.
				actions: [
					'iam:PutRolePolicy',
					'iam:GetRole',
					'iam:TagRole',
					'iam:DeleteRolePolicy',
					'iam:DeleteRole',
				],
				resources: [previewRoleArn],
			})
		)
		// The api mints the role; the JOB passes it to ECS when it creates the Express service, so
		// iam:PassRole lives on the job task role (resources-stack), not here. The api holds no
		// PassRole on preview roles at all — least privilege, and one fewer path from an api
		// compromise to a running task with a role of the attacker's choosing.
		resources.previewBucket.grantReadWrite(taskRole)

		// MARK: DNS
		// MARK: Same-origin API — CloudFront forwards /bff/* on both SPAs to the ALB (no CORS needed)
		const apiOrigin = domain
			? new HttpOrigin(domain.apiDomainName)
			: new HttpOrigin(api.loadBalancer.loadBalancerDnsName, {
					protocolPolicy: OriginProtocolPolicy.HTTP_ONLY,
				})
		for (const { distribution } of [site, portal]) {
			distribution.addBehavior('/bff/*', apiOrigin, {
				viewerProtocolPolicy: ViewerProtocolPolicy.HTTPS_ONLY,
				allowedMethods: AllowedMethods.ALLOW_ALL,
				cachePolicy: CachePolicy.CACHING_DISABLED,
				originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
			})
		}

		if (domain && hostedZone) {
			new ARecord(this, 'SiteRecord', {
				zone: hostedZone,
				recordName: domain.siteDomainName,
				target: RecordTarget.fromAlias(new CloudFrontTarget(site.distribution)),
			})
			new ARecord(this, 'PortalRecord', {
				zone: hostedZone,
				recordName: domain.portalDomainName,
				target: RecordTarget.fromAlias(new CloudFrontTarget(portal.distribution)),
			})
			new ARecord(this, 'ApiRecord', {
				zone: hostedZone,
				recordName: domain.apiDomainName,
				target: RecordTarget.fromAlias(new LoadBalancerTarget(api.loadBalancer)),
			})
		}

		// MARK: Outputs
		new CfnOutput(this, 'SiteUrl', { value: site.url, exportName: 'site-url' })
		new CfnOutput(this, 'PortalUrl', { value: portal.url, exportName: 'portal-url' })
		new CfnOutput(this, 'ApiUrl', {
			value: apiUrl ?? `http://${api.loadBalancer.loadBalancerDnsName}`,
			exportName: 'api-url',
		})
	}
}
