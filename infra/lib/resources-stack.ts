import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import { NatProvider, Peer, Port, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2'
import {
	Cluster,
	ContainerDependencyCondition,
	ContainerImage,
	CpuArchitecture,
	FargateTaskDefinition,
	LogDrivers,
	OperatingSystemFamily,
} from 'aws-cdk-lib/aws-ecs'
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam'
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs'
import {
	Credentials,
	DatabaseInstance,
	DatabaseInstanceEngine,
	PostgresEngineVersion,
	StorageType,
} from 'aws-cdk-lib/aws-rds'
import { HostedZone } from 'aws-cdk-lib/aws-route53'
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3'
import { Secret } from 'aws-cdk-lib/aws-secretsmanager'
import { EmailIdentity, Identity } from 'aws-cdk-lib/aws-ses'

import type { StackProps } from 'aws-cdk-lib'
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager'
import type { Construct } from 'constructs'
import type { EnvironmentConfig } from './config.ts'

export interface ResourcesStackProps extends StackProps {
	environment: EnvironmentConfig
	/** Absolute path to the repository root (Docker build context for the job images) */
	repositoryRoot: string
}

/** Application secrets that are filled in manually (see README "Secrets") */
export type ExternalSecretName =
	| 'anthropic-api-key'
	| 'auth-jwt-private-key'
	| 'github-token'
	| 'stripe-secret-key'
	| 'stripe-webhook-secret'

/**
 * Foundational, long-lived resources shared by the application stacks: networking,
 * Postgres, the artifacts bucket, secrets and the ECS cluster that runs build jobs.
 * Deploy this first. Everything here is RETAINed in live so a stack replacement never
 * deletes data.
 */
export class ResourcesStack extends Stack {
	readonly vpc: Vpc
	/** Id of the single NAT gateway (for the egress-cost alarm in OpsStack) */
	readonly natGatewayId: string
	readonly database: DatabaseInstance
	/** Secrets Manager secret with `username`/`password`/`host`/`port`/`dbname` for Postgres */
	readonly databaseSecret: ISecret
	/** Job deliverables: repo zips, docs, test reports (M5) */
	readonly artifactsBucket: Bucket
	readonly secrets: Record<ExternalSecretName, ISecret>
	/** ECS cluster for build jobs (M3) */
	readonly jobsCluster: Cluster
	readonly jobTaskDefinition: FargateTaskDefinition
	readonly jobSecurityGroup: SecurityGroup
	/** Instance role of the App Runner services the job creates per delivery (M5) */
	readonly appRunnerInstanceRole: Role
	/** Hosts the job container reaches without the egress proxy; WebStack appends the api host */
	readonly jobNoProxyHosts: string[]
	/** `/mf/<env>/jobs` — JSON lines from the job + proxy containers (see docs/RUNBOOK.md) */
	readonly jobLogGroup: LogGroup
	/** Postgres security group; consumers add their own ingress rule (see WebStack) */
	readonly databaseSecurityGroup: SecurityGroup
	/** SES sending identity for the hosted-zone domain (only with `domain` config) */
	readonly emailIdentity?: EmailIdentity

	constructor(scope: Construct, id: string, props: ResourcesStackProps) {
		super(scope, id, props)

		const { environment, repositoryRoot } = props
		const isLive = environment.name === 'live'
		const removalPolicy = isLive ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY

		this.templateOptions.description = `Shared resources (${environment.name})`

		// MARK: Networking
		// 2 AZs; one NAT gateway (≈ 35 USD/month) shared by both private subnets. The provider is
		// the default one — it is only instantiated here so the gateway id can be read for alarms.
		const natGatewayProvider = NatProvider.gateway()
		this.vpc = new Vpc(this, 'Vpc', {
			maxAzs: 2,
			natGateways: 1,
			natGatewayProvider,
			subnetConfiguration: [
				{ name: 'public', subnetType: SubnetType.PUBLIC },
				{ name: 'private', subnetType: SubnetType.PRIVATE_WITH_EGRESS },
				{ name: 'isolated', subnetType: SubnetType.PRIVATE_ISOLATED },
			],
		})
		this.natGatewayId = natGatewayProvider.configuredGateways[0]!.gatewayId

		// MARK: RDS Postgres 17 — automated backups (`backupRetentionDays`: 7 dev / 30 live), live
		// is deletion-protected and takes a final snapshot if the instance is ever removed from
		// the stack; dev is simply destroyed.
		this.databaseSecurityGroup = new SecurityGroup(this, 'DatabaseSecurityGroup', {
			vpc: this.vpc,
			description: 'Postgres - ingress granted per consumer',
			allowAllOutbound: false,
		})
		this.database = new DatabaseInstance(this, 'Database', {
			securityGroups: [this.databaseSecurityGroup],
			engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_17 }),
			instanceType: environment.database.instanceType,
			vpc: this.vpc,
			vpcSubnets: { subnetType: SubnetType.PRIVATE_ISOLATED },
			databaseName: 'mf',
			credentials: Credentials.fromGeneratedSecret('mf'),
			allocatedStorage: environment.database.allocatedStorageGb,
			storageType: StorageType.GP3,
			multiAz: false,
			backupRetention: Duration.days(environment.database.backupRetentionDays),
			deletionProtection: isLive,
			removalPolicy: isLive ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
			storageEncrypted: true,
			autoMinorVersionUpgrade: true,
		})
		this.databaseSecret = this.database.secret!

		// MARK: S3 — one bucket for all job deliverables (repo zips, docs, test reports).
		// The template's generic attachments bucket was folded into this one. Versioned so an
		// overwritten/deleted deliverable can be recovered for 90 days (M9 backups).
		this.artifactsBucket = new Bucket(this, 'ArtifactsBucket', {
			blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
			encryption: BucketEncryption.S3_MANAGED,
			enforceSSL: true,
			versioned: true,
			lifecycleRules: [
				{ abortIncompleteMultipartUploadAfter: Duration.days(7) },
				{ noncurrentVersionExpiration: Duration.days(90) },
			],
			removalPolicy,
			autoDeleteObjects: !isLive,
		})

		// MARK: Secrets Manager placeholders — values are set out-of-band (README "Secrets").
		const createSecret = (name: ExternalSecretName) =>
			new Secret(this, `Secret-${name}`, {
				secretName: `mf/${environment.name}/${name}`,
				description: `${name} for mf ${environment.name} — placeholder, fill via put-secret-value`,
				generateSecretString: { excludePunctuation: true, passwordLength: 32 },
				removalPolicy,
			})
		this.secrets = {
			'anthropic-api-key': createSecret('anthropic-api-key'),
			// Ed25519 private JWK the api signs tokens with: `node scripts/gen-auth-key.mjs`
			'auth-jwt-private-key': createSecret('auth-jwt-private-key'),
			'github-token': createSecret('github-token'),
			'stripe-secret-key': createSecret('stripe-secret-key'),
			'stripe-webhook-secret': createSecret('stripe-webhook-secret'),
		}

		// MARK: SES — verified sending domain with DKIM records in the hosted zone. Sending to
		// arbitrary addresses still needs production access (TODO-EXTERNAL).
		if (environment.domain) {
			const hostedZone = HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
				hostedZoneId: environment.domain.hostedZoneId,
				zoneName: environment.domain.hostedZoneName,
			})
			this.emailIdentity = new EmailIdentity(this, 'EmailIdentity', {
				identity: Identity.publicHostedZone(hostedZone),
				mailFromDomain: `mail.${environment.domain.hostedZoneName}`,
			})
		}

		// MARK: ECS — build jobs (M3). Tasks are started per job by the api (RunTask).
		this.jobsCluster = new Cluster(this, 'JobsCluster', {
			vpc: this.vpc,
			clusterName: `mf-jobs-${environment.name}`,
		})

		// Job security group. Egress: 443/80 to anywhere — the proxy sidecar, AWS APIs and the api's
		// ALB (the job reports through `/internal/jobs/:id` with a per-job token; M3 hardening).
		// No Postgres: the container never holds a database credential (docs/M3-REVIEW.md #18).
		// Fargate sidecars share the task ENI, so this SG cannot tell proxy traffic from a process
		// that ignores HTTPS_PROXY — the domain allowlist is enforced by the sidecar (see
		// apps/job/proxy); a hard fence needs a proxy in its own task/SG (TODO-EXTERNAL.md).
		this.jobSecurityGroup = new SecurityGroup(this, 'JobSecurityGroup', {
			vpc: this.vpc,
			// Description kept verbatim from M1: changing it replaces the SG, whose id mf-dev imports
			description: 'Build job tasks (TODO M3: egress allowlist)',
			allowAllOutbound: false,
		})
		this.jobSecurityGroup.addEgressRule(Peer.anyIpv4(), Port.tcp(443), 'https (proxy + AWS APIs)')
		this.jobSecurityGroup.addEgressRule(
			Peer.anyIpv4(),
			Port.tcp(80),
			'http (registry redirects, api ALB without a domain)'
		)

		const jobLogGroup = new LogGroup(this, 'JobLogGroup', {
			logGroupName: `/mf/${environment.name}/jobs`,
			retention: RetentionDays.TWO_WEEKS,
			removalPolicy,
		})
		this.jobLogGroup = jobLogGroup

		this.jobTaskDefinition = new FargateTaskDefinition(this, 'JobTaskDefinition', {
			family: `mf-job-${environment.name}`,
			cpu: environment.jobs.cpu,
			memoryLimitMiB: environment.jobs.memoryMiB,
			runtimePlatform: {
				cpuArchitecture: CpuArchitecture.X86_64,
				operatingSystemFamily: OperatingSystemFamily.LINUX,
			},
		})

		// Egress allowlist sidecar: tinyproxy, FilterDefaultDeny, domains in apps/job/proxy/filter
		// (npm, GitHub, Anthropic). Shares localhost with the job container (awsvpc).
		const proxyPort = 8888
		const proxy = this.jobTaskDefinition.addContainer('egress-proxy', {
			image: ContainerImage.fromAsset(`${repositoryRoot}/apps/job/proxy`),
			essential: true,
			memoryReservationMiB: 64,
			logging: LogDrivers.awsLogs({ logGroup: jobLogGroup, streamPrefix: 'proxy' }),
			healthCheck: {
				command: ['CMD-SHELL', `nc -z 127.0.0.1 ${proxyPort} || exit 1`],
				interval: Duration.seconds(10),
				retries: 3,
				startPeriod: Duration.seconds(5),
			},
		})

		// MARK: App Runner (M5). Services are created at runtime by the job, one per delivery, from
		// the customer's GitHub repo — nothing App Runner-shaped lives in our stacks except the
		// instance role the job passes to every service: a role with no policies (the customer api
		// needs no AWS access in the preview), so `iam:PassRole` on it grants nothing extra.
		this.appRunnerInstanceRole = new Role(this, 'AppRunnerInstanceRole', {
			roleName: `mf-apprunner-instance-${environment.name}`,
			assumedBy: new ServicePrincipal('tasks.apprunner.amazonaws.com'),
			description: 'Instance role of customer preview services created by build jobs (M5)',
		})

		// The job container: apps/job/Dockerfile (harness + golden template). `JOB_ID`, the per-job
		// `JOB_TOKEN`, `API_URL` and the final `NO_PROXY` (this list + the api host, `JOB_NO_PROXY`
		// on the api — the ALB lives in mf-<env>, which depends on this stack) are set per run by
		// the api's ecs:RunTask override. Only the ECS credential/metadata endpoints, Secrets
		// Manager, the artifacts bucket, App Runner (M5) and the api bypass the proxy (NO_PROXY,
		// exact hosts — a wildcard `.amazonaws.com` would let any AWS-hosted endpoint skip the
		// allowlist); everything else, including every other AWS service, must pass the allowlist.
		this.jobNoProxyHosts = [
			'127.0.0.1',
			'localhost',
			'169.254.170.2',
			'169.254.169.254',
			`secretsmanager.${this.region}.amazonaws.com`,
			`${this.artifactsBucket.bucketName}.s3.${this.region}.amazonaws.com`,
			`${this.artifactsBucket.bucketName}.s3.amazonaws.com`,
			`apprunner.${this.region}.amazonaws.com`,
		]
		const job = this.jobTaskDefinition.addContainer('job', {
			image: ContainerImage.fromAsset(repositoryRoot, { file: 'apps/job/Dockerfile' }),
			essential: true,
			logging: LogDrivers.awsLogs({ logGroup: jobLogGroup, streamPrefix: 'job' }),
			environment: {
				ENV: environment.name,
				ARTIFACTS_BUCKET: this.artifactsBucket.bucketName,
				ANTHROPIC_API_KEY_SECRET_ARN: this.secrets['anthropic-api-key'].secretArn,
				// M5 delivery: GitHub push + App Runner preview + bundle upload
				GITHUB_TOKEN_SECRET_ARN: this.secrets['github-token'].secretArn,
				APPRUNNER_INSTANCE_ROLE_ARN: this.appRunnerInstanceRole.roleArn,
				...(environment.appRunner
					? { APPRUNNER_CONNECTION_ARN: environment.appRunner.connectionArn }
					: {}),
				// The preview api verifies tokens against our api (it publishes a JWKS); only known
				// here with a custom domain — without it the deploy step is skipped (deployUrl null)
				...(environment.auth.issuer ? { PREVIEW_AUTH_ISSUER: environment.auth.issuer } : {}),
				HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
				HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
				NO_PROXY: this.jobNoProxyHosts.join(','),
				NODE_USE_ENV_PROXY: '1',
			},
		})
		job.addContainerDependencies({
			container: proxy,
			condition: ContainerDependencyCondition.HEALTHY,
		})

		// MARK: Job task role — reviewed M9, narrowed by M3 hardening, extended M5. The container
		// runs customer-driven code, so it gets exactly what apps/job needs today:
		//   secretsmanager:GetSecretValue on anthropic-api-key — the build itself (Agent SDK workers)
		//   secretsmanager:GetSecretValue on github-token      — M5: create + push the customer repo.
		//     The M9 review removed this grant expecting a short-lived per-job token; that needs a
		//     GitHub App (TODO-EXTERNAL), so the org token is BACK for v1. apps/job reads it once at
		//     start-up and strips it from the environment the sandbox (workers, npm scripts) sees;
		//     it is still reachable by code running in the job process — accepted until the App exists.
		//   s3:PutObject*/Abort* on the artifacts bucket       — upload deliverables (never read/list/delete)
		//   apprunner:Create/Describe/List/StartDeployment    — M5: preview service from the pushed repo.
		//     Create/Tag only with the `Service=mf-delivery` request tag, Describe/StartDeployment only
		//     on services carrying it: the job can touch preview services, never anything else in
		//     the account. A job CAN still create a preview from any repo the org-wide App Runner
		//     connection sees (every customer repo) — a connection per org / GitHub App is TODO-EXTERNAL.
		//   iam:PassRole on the (empty) App Runner instance role — required by CreateService
		// The job row + events go through the api's `/internal/jobs/:id` endpoint with a per-job
		// token (RunTask override), so there is no database grant and no 5432 rule any more
		// (docs/M3-REVIEW.md #18). Never: Stripe keys, the auth signing key, ecs:* or logs:* (the
		// execution role writes logs). Secrets reach the container as ARNs and are fetched at start-up.
		//
		// KNOWN GAP (PLAN.md, "M3 hardening"): PutObject is bucket-wide, so a job can overwrite
		// (not read) another job's deliverable — versioning keeps the previous copy. Goes away
		// when uploads move behind the same per-job endpoint (M5 delivery).
		this.secrets['anthropic-api-key'].grantRead(this.jobTaskDefinition.taskRole)
		this.secrets['github-token'].grantRead(this.jobTaskDefinition.taskRole)
		this.artifactsBucket.grantPut(this.jobTaskDefinition.taskRole)
		// App Runner has no grant* helpers. ListServices is account-level; the rest is fenced by the
		// `Service=mf-delivery` tag the job sets on every service it creates.
		const previewTag = { 'aws:RequestTag/Service': 'mf-delivery' }
		const previewResourceTag = { 'aws:ResourceTag/Service': 'mf-delivery' }
		this.jobTaskDefinition.taskRole.addToPrincipalPolicy(
			new PolicyStatement({
				sid: 'AppRunnerListServices',
				actions: ['apprunner:ListServices'],
				resources: ['*'],
			})
		)
		this.jobTaskDefinition.taskRole.addToPrincipalPolicy(
			new PolicyStatement({
				sid: 'AppRunnerCreatePreviewServices',
				actions: ['apprunner:CreateService', 'apprunner:TagResource'],
				resources: ['*'],
				conditions: { StringEquals: previewTag },
			})
		)
		this.jobTaskDefinition.taskRole.addToPrincipalPolicy(
			new PolicyStatement({
				sid: 'AppRunnerRedeployPreviewServices',
				actions: ['apprunner:DescribeService', 'apprunner:StartDeployment'],
				resources: ['*'],
				conditions: { StringEquals: previewResourceTag },
			})
		)
		this.jobTaskDefinition.taskRole.addToPrincipalPolicy(
			new PolicyStatement({
				sid: 'PassAppRunnerInstanceRole',
				actions: ['iam:PassRole'],
				resources: [this.appRunnerInstanceRole.roleArn],
				conditions: { StringEquals: { 'iam:PassedToService': 'tasks.apprunner.amazonaws.com' } },
			})
		)

		// MARK: Outputs (export names never contain the environment — one account per environment)
		new CfnOutput(this, 'VpcId', { value: this.vpc.vpcId, exportName: 'vpc-id' })
		new CfnOutput(this, 'DatabaseEndpoint', {
			value: this.database.dbInstanceEndpointAddress,
			exportName: 'rds-endpoint',
		})
		new CfnOutput(this, 'DatabaseSecretArn', {
			value: this.databaseSecret.secretArn,
			exportName: 'rds-secret-arn',
		})
		new CfnOutput(this, 'ArtifactsBucketName', {
			value: this.artifactsBucket.bucketName,
			exportName: 's3-artifacts',
		})
		new CfnOutput(this, 'JobsClusterArn', {
			value: this.jobsCluster.clusterArn,
			exportName: 'ecs-jobs-cluster-arn',
		})
		new CfnOutput(this, 'JobTaskDefinitionArn', {
			value: this.jobTaskDefinition.taskDefinitionArn,
			exportName: 'ecs-job-task-definition-arn',
		})
		new CfnOutput(this, 'AppRunnerInstanceRoleArn', {
			value: this.appRunnerInstanceRole.roleArn,
			exportName: 'apprunner-instance-role-arn',
		})
		new CfnOutput(this, 'JobSecurityGroupId', {
			value: this.jobSecurityGroup.securityGroupId,
			exportName: 'ecs-job-security-group-id',
		})
	}
}
