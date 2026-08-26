import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import { Peer, Port, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2'
import {
	Cluster,
	ContainerDependencyCondition,
	ContainerImage,
	CpuArchitecture,
	FargateTaskDefinition,
	LogDrivers,
	OperatingSystemFamily,
} from 'aws-cdk-lib/aws-ecs'
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
		// 2 AZs; one NAT gateway (≈ 35 USD/month) shared by both private subnets.
		this.vpc = new Vpc(this, 'Vpc', {
			maxAzs: 2,
			natGateways: 1,
			subnetConfiguration: [
				{ name: 'public', subnetType: SubnetType.PUBLIC },
				{ name: 'private', subnetType: SubnetType.PRIVATE_WITH_EGRESS },
				{ name: 'isolated', subnetType: SubnetType.PRIVATE_ISOLATED },
			],
		})

		// MARK: RDS Postgres 17
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
			removalPolicy,
			storageEncrypted: true,
			autoMinorVersionUpgrade: true,
		})
		this.databaseSecret = this.database.secret!

		// MARK: S3 — one bucket for all job deliverables (repo zips, docs, test reports).
		// The template's generic attachments bucket was folded into this one.
		this.artifactsBucket = new Bucket(this, 'ArtifactsBucket', {
			blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
			encryption: BucketEncryption.S3_MANAGED,
			enforceSSL: true,
			versioned: true,
			lifecycleRules: [
				{ abortIncompleteMultipartUploadAfter: Duration.days(7) },
				{ noncurrentVersionExpiration: Duration.days(isLive ? 90 : 14) },
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

		// Job security group. Egress: 443/80 to anywhere (the proxy sidecar + AWS APIs) and Postgres.
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
		this.jobSecurityGroup.addEgressRule(Peer.anyIpv4(), Port.tcp(80), 'http (registry redirects)')
		this.jobSecurityGroup.addEgressRule(this.databaseSecurityGroup, Port.tcp(5432), 'postgres')
		this.databaseSecurityGroup.addIngressRule(
			this.jobSecurityGroup,
			Port.tcp(5432),
			'build jobs to postgres'
		)

		const jobLogGroup = new LogGroup(this, 'JobLogGroup', {
			logGroupName: `/mf/${environment.name}/jobs`,
			retention: RetentionDays.TWO_WEEKS,
			removalPolicy,
		})

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

		// The job container: apps/job/Dockerfile (harness + golden template). `JOB_ID` is set per
		// run by the api's ecs:RunTask override. Only the ECS credential/metadata endpoints, Secrets
		// Manager and the artifacts bucket bypass the proxy (NO_PROXY, exact hosts — a wildcard
		// `.amazonaws.com` would let any AWS-hosted endpoint skip the allowlist); everything else,
		// including every other AWS service, must pass the allowlist. The database is reached by
		// IP inside the VPC and is not affected by the proxy variables.
		const job = this.jobTaskDefinition.addContainer('job', {
			image: ContainerImage.fromAsset(repositoryRoot, { file: 'apps/job/Dockerfile' }),
			essential: true,
			logging: LogDrivers.awsLogs({ logGroup: jobLogGroup, streamPrefix: 'job' }),
			environment: {
				ENV: environment.name,
				ARTIFACTS_BUCKET: this.artifactsBucket.bucketName,
				DATABASE_SECRET_ARN: this.databaseSecret.secretArn,
				ANTHROPIC_API_KEY_SECRET_ARN: this.secrets['anthropic-api-key'].secretArn,
				HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
				HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
				NO_PROXY: [
					'127.0.0.1',
					'localhost',
					'169.254.170.2',
					'169.254.169.254',
					`secretsmanager.${this.region}.amazonaws.com`,
					`${this.artifactsBucket.bucketName}.s3.${this.region}.amazonaws.com`,
					`${this.artifactsBucket.bucketName}.s3.amazonaws.com`,
				].join(','),
				NODE_USE_ENV_PROXY: '1',
			},
		})
		job.addContainerDependencies({
			container: proxy,
			condition: ContainerDependencyCondition.HEALTHY,
		})

		// Job task role: the database (job row + events), the Anthropic build secret, write
		// artifacts. Never Stripe keys, the auth signing key or the GitHub token (M5 delivery mints
		// a short-lived per-job token instead) — no customer secrets inside the sandbox.
		this.databaseSecret.grantRead(this.jobTaskDefinition.taskRole)
		this.secrets['anthropic-api-key'].grantRead(this.jobTaskDefinition.taskRole)
		this.artifactsBucket.grantWrite(this.jobTaskDefinition.taskRole)

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
		new CfnOutput(this, 'JobSecurityGroupId', {
			value: this.jobSecurityGroup.securityGroupId,
			exportName: 'ecs-job-security-group-id',
		})
	}
}
