import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager'
import { SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2'
import { Cluster, ContainerImage, FargateTaskDefinition, LogDrivers } from 'aws-cdk-lib/aws-ecs'
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns'
import { ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import { AccessPoint, FileSystem, LifecyclePolicy, PerformanceMode, ThroughputMode } from 'aws-cdk-lib/aws-efs'
import { PolicyStatement } from 'aws-cdk-lib/aws-iam'
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs'
import { HostedZone } from 'aws-cdk-lib/aws-route53'

import type { StackProps } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import type { StatusConfig } from './config.ts'

export type StatusStackProps = StackProps & { config: StatusConfig }

/**
 * Deployed ONCE, standalone (like infra/mail) — one Uptime Kuma instance covers every
 * environment's public endpoints (dev.mjukvaruhuset.se, portal.dev, api.dev today; qa/live once
 * they have real domains), so it does not belong inside the per-environment
 * resources-<env>/mf-<env> loop (infra/bin/app.ts).
 *
 * Reuses an existing environment's VPC (infra/lib/resources-stack.ts) instead of paying for a
 * second NAT gateway: the task and its ALB both live in that VPC's PUBLIC subnets, with the task
 * given a public IP directly. That's enough because Uptime Kuma only needs outbound HTTPS to the
 * public URLs it polls and inbound HTTPS from whoever views the status page — unlike the api, it
 * never talks to the VPC's private resources (RDS, the jobs cluster), so it has no need for the
 * NAT-routed private subnets those do.
 *
 * State (SQLite database: monitors, history, settings) persists on an EFS access point mounted at
 * /app/data — survives a task replacement/redeploy, cheaper and simpler to operate than standing
 * up RDS for one small file.
 *
 * NOT done here: configuring the 3 monitors (site/portal/api). Uptime Kuma has no CDK-friendly
 * declarative config API, only its own setup UI on first login — that's a manual step after
 * deploy (see the PR description).
 */
export class StatusStack extends Stack {
	readonly service: ApplicationLoadBalancedFargateService

	constructor(scope: Construct, id: string, { config, ...props }: StatusStackProps) {
		super(scope, id, props)

		const hostedZone = HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
			hostedZoneId: config.hostedZoneId,
			zoneName: config.hostedZoneName,
		})

		const vpc = Vpc.fromVpcAttributes(this, 'Vpc', {
			vpcId: config.vpcId,
			availabilityZones: config.availabilityZones,
			publicSubnetIds: config.publicSubnetIds,
		})
		const taskSubnets = { subnetType: SubnetType.PUBLIC }

		// MARK: EFS — persistent SQLite state. One access point owned by root: the upstream
		// louislam/uptime-kuma image runs its process as root (no USER in its Dockerfile), so the
		// mount must be writable by uid/gid 0 rather than the usual non-root access-point convention.
		const fileSystem = new FileSystem(this, 'DataFileSystem', {
			vpc,
			vpcSubnets: taskSubnets,
			encrypted: true,
			lifecyclePolicy: LifecyclePolicy.AFTER_30_DAYS,
			performanceMode: PerformanceMode.GENERAL_PURPOSE,
			throughputMode: ThroughputMode.BURSTING,
			// Deployed once, not per dev/live env — always kept, like infra/mail's InboundBucket.
			removalPolicy: RemovalPolicy.RETAIN,
		})
		const accessPoint = new AccessPoint(this, 'DataAccessPoint', {
			fileSystem,
			path: '/data',
			createAcl: { ownerUid: '0', ownerGid: '0', permissions: '0755' },
			posixUser: { uid: '0', gid: '0' },
		})

		const logGroup = new LogGroup(this, 'LogGroup', {
			logGroupName: '/mf/status',
			retention: RetentionDays.ONE_MONTH,
			removalPolicy: RemovalPolicy.RETAIN,
		})

		const taskDefinition = new FargateTaskDefinition(this, 'TaskDefinition', {
			family: 'mf-status',
			// Uptime Kuma is a single lightweight Node process polling a handful of URLs — the
			// smallest Fargate size (256 cpu needs ≥ 512 MiB memory).
			cpu: 256,
			memoryLimitMiB: 512,
			volumes: [
				{
					name: 'kuma-data',
					efsVolumeConfiguration: {
						fileSystemId: fileSystem.fileSystemId,
						transitEncryption: 'ENABLED',
						authorizationConfig: { accessPointId: accessPoint.accessPointId, iam: 'ENABLED' },
					},
				},
			],
		})
		taskDefinition
			.addContainer('uptime-kuma', {
				image: ContainerImage.fromRegistry('louislam/uptime-kuma:1'),
				portMappings: [{ containerPort: 3001 }],
				logging: LogDrivers.awsLogs({ logGroup, streamPrefix: 'uptime-kuma' }),
			})
			.addMountPoints({ containerPath: '/app/data', sourceVolume: 'kuma-data', readOnly: false })

		// EFS access grants are per-access-point (no `grant*` helper covers this — FileSystem's own
		// helpers grant filesystem-wide access, wider than needed here): mount + read/write, fenced
		// to this one access point, nothing else on the filesystem.
		taskDefinition.taskRole.addToPrincipalPolicy(
			new PolicyStatement({
				actions: [
					'elasticfilesystem:ClientMount',
					'elasticfilesystem:ClientWrite',
					'elasticfilesystem:ClientRootAccess',
				],
				resources: [fileSystem.fileSystemArn],
				conditions: { StringEquals: { 'elasticfilesystem:AccessPointArn': accessPoint.accessPointArn } },
			})
		)

		this.service = new ApplicationLoadBalancedFargateService(this, 'Service', {
			cluster: new Cluster(this, 'Cluster', { vpc, clusterName: 'mf-status' }),
			taskDefinition,
			desiredCount: 1,
			minHealthyPercent: 0,
			circuitBreaker: { rollback: true },
			publicLoadBalancer: true,
			taskSubnets,
			// Public subnet, no NAT: the task needs a public IP to reach Docker Hub (this image is
			// not built as an asset/pushed to ECR — it's pulled straight from index.docker.io) and
			// the URLs it polls.
			assignPublicIp: true,
			protocol: ApplicationProtocol.HTTPS,
			redirectHTTP: true,
			certificate: Certificate.fromCertificateArn(this, 'Certificate', config.certificateArn),
			domainZone: hostedZone,
			domainName: config.domainName,
		})
		this.service.targetGroup.configureHealthCheck({ path: '/', interval: Duration.seconds(30) })
		// Mount-target security group: NFS (2049) from the task only.
		fileSystem.connections.allowDefaultPortFrom(this.service.service)

		new CfnOutput(this, 'StatusUrl', { value: `https://${config.domainName}` })
	}
}
