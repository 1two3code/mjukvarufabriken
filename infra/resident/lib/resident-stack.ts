import { CfnOutput, Duration, RemovalPolicy, Stack, Tags } from 'aws-cdk-lib'
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager'
import { Peer, Port, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2'
import {
	Cluster,
	ContainerImage,
	FargateService,
	FargateTaskDefinition,
	LogDrivers,
} from 'aws-cdk-lib/aws-ecs'
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns'
import { ApplicationProtocol, SslPolicy } from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs'
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3'
import { Secret } from 'aws-cdk-lib/aws-secretsmanager'

import type { StackProps } from 'aws-cdk-lib'
import type { ISecret } from 'aws-cdk-lib/aws-secretsmanager'
import type { Construct } from 'constructs'
import type { ResidentConfig } from './config.ts'

export type ResidentStackProps = StackProps & {
	config: ResidentConfig
	/** Repository root — the resident image is built from `packages/resident/Dockerfile` */
	repositoryRoot: string
}

/**
 * Secrets the customer fills in after the first deploy. Until then each holds a JSON placeholder
 * (`{"placeholder":"…","<name>":"<random>"}`) that the resident's `config.ts` recognises as "not
 * configured" — a random string alone would pass for a credential. The admin token is the
 * exception: its generated value is a usable bearer right away.
 */
export const residentSecretNames = [
	'anthropic-api-key',
	'github-token',
	'factory-token',
	'admin-token',
] as const
export type ResidentSecretName = (typeof residentSecretNames)[number]

/**
 * Everything the resident agent needs, in the customer's account: a VPC with public subnets
 * only (no NAT gateway — the task gets a public IP and talks to GitHub / Anthropic / the
 * factory over it), one Fargate task, a bucket for audit log + usage records, four secrets
 * (their Anthropic key, a GitHub token scoped to the one repository, the factory bearer, the
 * control-api token) and a task role that can read exactly those secrets and write exactly that
 * bucket. Scoped to one repository by `GITHUB_REPOSITORY` and by the token the customer issues.
 */
export class ResidentStack extends Stack {
	readonly bucket: Bucket
	readonly secrets: Record<ResidentSecretName, ISecret>
	readonly service: FargateService
	readonly taskDefinition: FargateTaskDefinition

	constructor(
		scope: Construct,
		id: string,
		{ config, repositoryRoot, ...props }: ResidentStackProps
	) {
		super(scope, id, props)
		Tags.of(this).add('Service', 'mf-resident')
		Tags.of(this).add('Repository', config.repository)

		// MARK: Network — public subnets, no NAT (≈ 0 USD/month for the network itself)
		const vpc = new Vpc(this, 'Vpc', {
			maxAzs: 2,
			natGateways: 0,
			subnetConfiguration: [{ name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
		})

		// MARK: Audit + metering bucket — versioned, private, kept on stack deletion
		this.bucket = new Bucket(this, 'Bucket', {
			blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
			encryption: BucketEncryption.S3_MANAGED,
			enforceSSL: true,
			versioned: true,
			removalPolicy: RemovalPolicy.RETAIN,
			lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(90) }],
		})

		// MARK: Secrets — placeholders, filled with `aws secretsmanager put-secret-value`
		const createSecret = (name: ResidentSecretName, { usable = false } = {}) =>
			new Secret(this, `Secret-${name}`, {
				secretName: `mf-resident/${config.installationId}/${name}`,
				description: `${name} for the Mjukvaruhuset resident on ${config.repository} — fill via put-secret-value`,
				generateSecretString: {
					excludePunctuation: true,
					passwordLength: 32,
					...(usable
						? {}
						: {
								secretStringTemplate: JSON.stringify({ placeholder: 'fill via put-secret-value' }),
								generateStringKey: name,
							}),
				},
				removalPolicy: RemovalPolicy.DESTROY,
			})
		this.secrets = {
			'anthropic-api-key': createSecret('anthropic-api-key'),
			'github-token': createSecret('github-token'),
			'factory-token': createSecret('factory-token'),
			// The generated value is a usable admin token right away
			'admin-token': createSecret('admin-token', { usable: true }),
		}

		// MARK: Service
		const cluster = new Cluster(this, 'Cluster', { vpc, containerInsightsV2: undefined })
		const logGroup = new LogGroup(this, 'Logs', {
			logGroupName: `/mf-resident/${config.installationId}`,
			retention: RetentionDays.THREE_MONTHS,
			removalPolicy: RemovalPolicy.DESTROY,
		})

		this.taskDefinition = new FargateTaskDefinition(this, 'TaskDefinition', {
			cpu: config.cpu,
			memoryLimitMiB: config.memoryMiB,
			family: `mf-resident-${config.installationId}`.slice(0, 255),
		})
		// Only ARNs and non-secret settings in the task definition; every credential is read from
		// Secrets Manager at start-up (the resident's `config.ts`) and never injected by ECS: the
		// worker sessions share the container (same uid) and could read the initial environment of
		// pid 1 from /proc, which `delete process.env[...]` does not touch.
		const environment: Record<string, string> = {
			ENV: 'resident',
			GITHUB_REPOSITORY: config.repository,
			RESIDENT_INSTALLATION_ID: config.installationId,
			RESIDENT_MONTHLY_TOKENS: String(config.monthlyTokens),
			RESIDENT_TASK_TOKENS: String(config.taskTokens),
			RESIDENT_BUCKET: this.bucket.bucketName,
			FACTORY_API_URL: config.factoryApiUrl,
			ANTHROPIC_API_KEY_SECRET_ARN: this.secrets['anthropic-api-key'].secretArn,
			GITHUB_TOKEN_SECRET_ARN: this.secrets['github-token'].secretArn,
			FACTORY_TOKEN_SECRET_ARN: this.secrets['factory-token'].secretArn,
			RESIDENT_ADMIN_TOKEN_SECRET_ARN: this.secrets['admin-token'].secretArn,
			PORT: '5176',
			ADDRESS: '0.0.0.0',
			...(config.workerModel ? { WORKER_MODEL: config.workerModel } : {}),
			...(config.planModel ? { PLAN_MODEL: config.planModel } : {}),
		}
		this.taskDefinition.addContainer('resident', {
			image: ContainerImage.fromAsset(repositoryRoot, {
				file: 'packages/resident/Dockerfile',
				exclude: ['**/node_modules', '**/dist', '**/cdk.out', '.git', 'apps', 'infra', 'docs'],
			}),
			logging: LogDrivers.awsLogs({ logGroup, streamPrefix: 'resident' }),
			environment,
			portMappings: [{ containerPort: 5176 }],
			healthCheck: {
				command: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:5176/health || exit 1'],
				interval: Duration.seconds(30),
				startPeriod: Duration.seconds(60),
			},
			stopTimeout: Duration.seconds(120),
		})

		// MARK: Least privilege — read the four secrets, read + put on the bucket (no delete: the
		// versioned audit trail must not be erasable with the task's own credentials), nothing else
		const { taskRole } = this.taskDefinition
		for (const secret of Object.values(this.secrets)) secret.grantRead(taskRole)
		this.bucket.grantRead(taskRole)
		this.bucket.grantPut(taskRole)

		const securityGroup = new SecurityGroup(this, 'ServiceSecurityGroup', {
			vpc,
			description: 'Mjukvaruhuset resident: egress only unless the control api is exposed',
			allowAllOutbound: true,
		})

		if (config.exposeApi) {
			// The admin bearer and `POST /tasks` (code changes in the customer's repo) travel over
			// this listener: HTTPS only, with the customer's ACM certificate; http redirects.
			if (!config.certificateArn) {
				throw new Error('exposeApi needs -c certificateArn=<ACM certificate ARN> (HTTPS only)')
			}
			const exposed = new ApplicationLoadBalancedFargateService(this, 'Service', {
				cluster,
				taskDefinition: this.taskDefinition,
				desiredCount: 1,
				assignPublicIp: true,
				taskSubnets: { subnetType: SubnetType.PUBLIC },
				securityGroups: [securityGroup],
				publicLoadBalancer: true,
				protocol: ApplicationProtocol.HTTPS,
				listenerPort: 443,
				certificate: Certificate.fromCertificateArn(this, 'Certificate', config.certificateArn),
				sslPolicy: SslPolicy.RECOMMENDED_TLS,
				redirectHTTP: true,
				minHealthyPercent: 0,
				maxHealthyPercent: 100,
				circuitBreaker: { rollback: true },
				healthCheckGracePeriod: Duration.seconds(90),
			})
			exposed.targetGroup.configureHealthCheck({ path: '/health' })
			this.service = exposed.service
			new CfnOutput(this, 'ControlApiUrl', {
				value: `https://${exposed.loadBalancer.loadBalancerDnsName}`,
				description:
					'Control api (bearer = the admin-token secret; point the certificate DNS name here): /status /pause /resume /tasks /audit',
			})
		} else {
			this.service = new FargateService(this, 'Service', {
				cluster,
				taskDefinition: this.taskDefinition,
				desiredCount: 1,
				assignPublicIp: true,
				vpcSubnets: { subnetType: SubnetType.PUBLIC },
				securityGroups: [securityGroup],
				// One task at a time: a second resident would build the same issues twice
				minHealthyPercent: 0,
				maxHealthyPercent: 100,
				circuitBreaker: { rollback: true },
				// `aws ecs execute-command` → curl the control api from inside (pause without an ALB)
				enableExecuteCommand: true,
			})
			securityGroup.addIngressRule(
				Peer.ipv4(vpc.vpcCidrBlock),
				Port.tcp(5176),
				'control api from inside the VPC'
			)
		}

		// MARK: Outputs
		new CfnOutput(this, 'BucketName', {
			value: this.bucket.bucketName,
			description:
				'Audit log (audit/<day>.jsonl), usage (usage/<day>.json), pause flag (state/paused.json)',
		})
		new CfnOutput(this, 'ClusterName', { value: cluster.clusterName })
		new CfnOutput(this, 'ServiceName', { value: this.service.serviceName })
		for (const name of residentSecretNames) {
			new CfnOutput(this, `Secret-${name}-arn`, { value: this.secrets[name].secretArn })
		}
	}
}
