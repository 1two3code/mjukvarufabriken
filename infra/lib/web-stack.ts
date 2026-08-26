import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
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
					JOBS_CLUSTER_ARN: resources.jobsCluster.clusterArn,
					// Family, not ARN: RunTask resolves the latest revision and there is no cross-stack
					// export that changes on every job image rebuild
					JOB_TASK_DEFINITION_ARN: resources.jobTaskDefinition.family,
					JOB_SUBNET_IDS: jobSubnets.subnetIds.join(','),
					JOB_SECURITY_GROUP_ID: resources.jobSecurityGroup.securityGroupId,
					ANTHROPIC_API_KEY_SECRET_ARN: resources.secrets['anthropic-api-key'].secretArn,
					STRIPE_SECRET_KEY_SECRET_ARN: resources.secrets['stripe-secret-key'].secretArn,
					STRIPE_WEBHOOK_SECRET_SECRET_ARN: resources.secrets['stripe-webhook-secret'].secretArn,
				},
			},
			// Private subnets with NAT: can reach RDS (isolated subnets in the same VPC) and the internet
			taskSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
		})
		api.targetGroup.configureHealthCheck({ path: '/health', interval: Duration.seconds(30) })
		this.api = api
		// The issuer is the api's own URL; without a custom domain it is only known after synth
		api.taskDefinition.defaultContainer!.addEnvironment(
			'AUTH_ISSUER',
			environment.auth.issuer ?? apiUrl ?? `http://${api.loadBalancer.loadBalancerDnsName}`
		)

		// MARK: Api task role — least privilege (reviewed M9). What each grant is for:
		//   secretsmanager:GetSecretValue on the RDS secret     — Postgres connection (DATABASE_SECRET_ARN)
		//   ... on anthropic-api-key                            — spec chat (M2 spec engine runs in the api)
		//   ... on auth-jwt-private-key                         — signs access tokens (EdDSA issuer)
		//   ... on stripe-secret-key / stripe-webhook-secret    — checkout + webhook verification (M6)
		//   s3 read/write on the artifacts bucket               — presigned deliverable downloads, uploads
		//   ses:SendEmail on the domain identity                — magic-link mail (only with a domain)
		//   ecs:RunTask (job family, jobs cluster only)         — start a build job
		//   ecs:DescribeTasks/StopTask/ListTasks (jobs cluster) — job status + admin kill switch
		//   iam:PassRole on the job task + execution roles      — required by RunTask
		// Not granted: github-token (M5 mints per-job tokens), logs:* (execution role), any
		// wildcard on secrets or buckets.
		const taskRole = api.taskDefinition.taskRole
		resources.databaseSecret.grantRead(taskRole)
		resources.secrets['anthropic-api-key'].grantRead(taskRole)
		resources.secrets['auth-jwt-private-key'].grantRead(taskRole)
		resources.secrets['stripe-secret-key'].grantRead(taskRole)
		resources.secrets['stripe-webhook-secret'].grantRead(taskRole)
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
