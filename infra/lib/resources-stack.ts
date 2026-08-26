import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import { SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2'
import {
	Cluster,
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
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3'
import { HostedZone } from 'aws-cdk-lib/aws-route53'
import { Secret } from 'aws-cdk-lib/aws-secretsmanager'
import { EmailIdentity, Identity } from 'aws-cdk-lib/aws-ses'

import type { StackProps } from 'aws-cdk-lib'
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager'
import type { Construct } from 'constructs'
import type { EnvironmentConfig } from './config.ts'

export interface ResourcesStackProps extends StackProps {
	environment: EnvironmentConfig
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

		const { environment } = props
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

		// TODO(M3): egress allowlist — restrict to npm, GitHub and Anthropic only.
		// Egress is wide open for now so the placeholder image can be pulled and tested.
		this.jobSecurityGroup = new SecurityGroup(this, 'JobSecurityGroup', {
			vpc: this.vpc,
			description: 'Build job tasks (TODO M3: egress allowlist)',
			allowAllOutbound: true,
		})

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
		this.jobTaskDefinition.addContainer('job', {
			// Placeholder until the harness image exists (M3)
			image: ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:24-alpine'),
			command: ['node', '-e', 'console.log("mf-job placeholder")'],
			logging: LogDrivers.awsLogs({ logGroup: jobLogGroup, streamPrefix: 'job' }),
			environment: {
				ENV: environment.name,
				ARTIFACTS_BUCKET: this.artifactsBucket.bucketName,
				ANTHROPIC_API_KEY_SECRET_ARN: this.secrets['anthropic-api-key'].secretArn,
				GITHUB_TOKEN_SECRET_ARN: this.secrets['github-token'].secretArn,
			},
		})
		// Job task role: read the two build secrets, write artifacts. Nothing else — never the
		// database secret or Stripe keys (no customer secrets inside the sandbox).
		this.secrets['anthropic-api-key'].grantRead(this.jobTaskDefinition.taskRole)
		this.secrets['github-token'].grantRead(this.jobTaskDefinition.taskRole)
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
