import { CfnOutput, CustomResource, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import { BuildSpec, LinuxBuildImage, Project, Source } from 'aws-cdk-lib/aws-codebuild'
import {
	GatewayVpcEndpointAwsService,
	InterfaceVpcEndpointAwsService,
	NatProvider,
	Peer,
	Port,
	SecurityGroup,
	SubnetType,
	Vpc,
} from 'aws-cdk-lib/aws-ec2'
import { Repository, TagStatus } from 'aws-cdk-lib/aws-ecr'
import {
	Cluster,
	ContainerDependencyCondition,
	ContainerImage,
	CpuArchitecture,
	FargateService,
	FargateTaskDefinition,
	LogDrivers,
	OperatingSystemFamily,
} from 'aws-cdk-lib/aws-ecs'
import { ArnPrincipal, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam'
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda'
import { Provider } from 'aws-cdk-lib/custom-resources'
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
	| 'github-app-key'
	| 'github-oauth-client-secret'
	| 'sentry-dsn'
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
	/**
	 * Assumed per-job by the job task role (never granted S3 directly) with an inline session
	 * policy the job process builds from its own `JOB_ID`, narrowing this role's own
	 * `deliverables/*` + `delivery-source/*` ceiling down to that one job's prefix/key
	 * (M3 hardening #1 — see the job task role MARK below).
	 */
	readonly jobArtifactsRole: Role
	readonly jobSecurityGroup: SecurityGroup
	/** ECR repository the delivery pushes built customer images to (M5, ECS Express) */
	readonly deliverablesRepository: Repository
	/** CodeBuild project that builds + pushes the customer image from the S3 source zip (M5) */
	readonly deliveryBuildProject: Project
	/** Task-execution role of the ECS Express preview services the job creates per delivery (M5) */
	readonly expressExecutionRole: Role
	/** Infrastructure role ECS Express assumes to provision the managed ALB per delivery (M5) */
	readonly expressInfrastructureRole: Role
	/** Shared bucket delivered preview apps store objects in, each under its own `preview/<job>/` prefix */
	readonly previewBucket: Bucket
	/**
	 * Security group the DELIVERED preview apps run in. Passing our own network configuration to
	 * `CreateExpressGatewayService` (the API accepts one; we previously let AWS choose) is what makes
	 * a precise RDS rule possible at all — an Express-chosen group is created per service and cannot
	 * be referenced from here, so the only alternative was opening 5432 to the whole VPC, which
	 * would also have handed it to the build job and broken the M3 invariant that keeps the job off
	 * the database.
	 */
	readonly previewAppSecurityGroup: SecurityGroup
	/**
	 * Permissions boundary every per-app preview role must carry. It is the ceiling on what such a
	 * role can EVER hold — the api creates those roles, so a bug (or a compromise) in the api still
	 * cannot mint a role more powerful than "objects in the preview bucket".
	 */
	readonly previewRoleBoundary: ManagedPolicy
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
		//
		// deletionProtection is deliberately NOT hardcoded to `isLive`: on a stack's very FIRST
		// create, any other resource failing later in the same deploy makes CloudFormation roll
		// back the WHOLE stack, including the DB it just finished creating — and a protected RDS
		// instance refuses that DeleteDBInstance, wedging the stack in ROLLBACK_FAILED (hardening
		// audit 2026-08-30, finding F1). MF_RDS_DELETION_PROTECTION=false is the operator escape
		// hatch for a first live stand-up: deploy resources-live once with it set, confirm
		// CREATE_COMPLETE, then redeploy without it — flipping protection on is an in-place
		// ModifyDBInstance, not a replacement. Any other value (including unset) keeps the
		// existing isLive default.
		const deletionProtection =
			process.env.MF_RDS_DELETION_PROTECTION === 'false' ? false : isLive
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
			deletionProtection,
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
			'github-app-key': createSecret('github-app-key'),
			// Client secret of the "Sign in with GitHub" OAuth App (M6; TODO-EXTERNAL)
			'github-oauth-client-secret': createSecret('github-oauth-client-secret'),
			// Error tracking (SaaS, free tier) DSN for the api; TODO-EXTERNAL until a Sentry project
			// exists — the api's `sentry` plugin decorates an inert client while this is a placeholder
			'sentry-dsn': createSecret('sentry-dsn'),
			'stripe-secret-key': createSecret('stripe-secret-key'),
			'stripe-webhook-secret': createSecret('stripe-webhook-secret'),
		}

		// The api parses `auth-jwt-private-key` as an Ed25519 JWK at boot and crash-loops on the random
		// placeholder above (seen standing up qa from a fresh account). Seed it with a real key on
		// deploy — idempotent: the handler only (re)generates when the value is NOT a valid Ed25519 JWK,
		// so a populated env (dev) and every re-deploy are no-ops. The key is generated in-account and
		// never leaves it. Replaces the manual `node scripts/gen-auth-key.mjs | put-secret-value`.
		const authKeySeed = new LambdaFunction(this, 'AuthKeySeed', {
			runtime: Runtime.NODEJS_20_X,
			handler: 'index.handler',
			timeout: Duration.seconds(30),
			code: Code.fromInline(
				[
					`const { SecretsManagerClient, GetSecretValueCommand, PutSecretValueCommand } = require('@aws-sdk/client-secrets-manager')`,
					`const { generateKeyPairSync } = require('crypto')`,
					`exports.handler = async (event) => {`,
					`  if (event.RequestType === 'Delete') return`,
					`  const SecretId = event.ResourceProperties.SecretArn`,
					`  const sm = new SecretsManagerClient({})`,
					// GetSecretValue is intentionally NOT wrapped in try/catch: the secret is always
					// pre-created by createSecret() above, so a failure here (throttle, KMS hiccup, IAM
					// eventual consistency on a re-invoke) is anomalous — let it throw and abort the
					// custom resource rather than silently falling into the "regenerate" branch below,
					// which would invalidate every live token on a merely transient read error.
					`  const current = await sm.send(new GetSecretValueCommand({ SecretId }))`,
					`  let valid = false`,
					`  try { const j = JSON.parse(current.SecretString); valid = j && j.kty === 'OKP' && j.crv === 'Ed25519' && !!j.d } catch (e) {}`,
					`  if (!valid) {`,
					`    const { privateKey } = generateKeyPairSync('ed25519')`,
					`    await sm.send(new PutSecretValueCommand({ SecretId, SecretString: JSON.stringify(privateKey.export({ format: 'jwk' })) }))`,
					`  }`,
					`}`,
				].join('\n')
			),
		})
		this.secrets['auth-jwt-private-key'].grantRead(authKeySeed)
		this.secrets['auth-jwt-private-key'].grantWrite(authKeySeed)
		const authKeySeedProvider = new Provider(this, 'AuthKeySeedProvider', { onEventHandler: authKeySeed })
		new CustomResource(this, 'AuthKeySeedResource', {
			serviceToken: authKeySeedProvider.serviceToken,
			properties: { SecretArn: this.secrets['auth-jwt-private-key'].secretArn },
		})

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

		// Job security group. Two modes (C1 hard egress fence, hardening audit 2026-08-30 — flag
		// `jobs.egressFence`, DEFAULT OFF so dev stays byte-identical):
		//  off — egress 443/80 to anywhere: the proxy sidecar, AWS APIs and the api's ALB (the job
		//        reports through `/internal/jobs/:id` with a per-job token; M3 hardening). Fargate
		//        sidecars share the task ENI, so this SG cannot tell proxy traffic from a process
		//        that ignores HTTPS_PROXY — the domain allowlist is enforced by the sidecar only
		//        (`curl --noproxy '*'` bypasses it, finding C1).
		//  on  — DENY BY DEFAULT: egress only to the proxy's own task/SG (the single way to the
		//        internet), the VPC interface endpoints and the S3 gateway prefix list. Job status
		//        reports to the api ride the PROXY too (the api host is added to the proxy
		//        allowlist below and web-stack keeps it out of NO_PROXY): the ALB is
		//        internet-facing, so an SG-to-SG rule at the job SG could never carry that traffic
		//        — it would be addressed to the ALB's public IPs, which no SG-referenced rule
		//        matches. The allowlist becomes a network fact instead of a convention. Flip
		//        requirements: docs/backlog/hardening-2026-08-30/c1-egress-fence.md.
		// No Postgres either way: the container never holds a database credential (M3-REVIEW #18).
		const egressFence = environment.jobs.egressFence === true
		if (egressFence && !environment.domain) {
			// The proxy allowlist needs the api's hostname at synth time; without `domain` the api
			// host is the ALB's generated DNS name, which lives in mf-<env> (a stack this one must
			// not depend on) — and a fenced job could then never reach the api to claim its report
			// token, poll the kill switch or send status. Fail the synth, not the first canary job.
			throw new Error(
				'jobs.egressFence requires `domain`: fenced job→api reports go through the egress ' +
					'proxy by hostname (FILTER_ALLOW_EXTRA), so the api needs a stable domain name'
			)
		}
		this.jobSecurityGroup = new SecurityGroup(this, 'JobSecurityGroup', {
			vpc: this.vpc,
			// Description kept verbatim from M1: changing it replaces the SG, whose id mf-dev imports
			description: 'Build job tasks (TODO M3: egress allowlist)',
			allowAllOutbound: false,
		})
		if (!egressFence) {
			this.jobSecurityGroup.addEgressRule(Peer.anyIpv4(), Port.tcp(443), 'https (proxy + AWS APIs)')
			this.jobSecurityGroup.addEgressRule(
				Peer.anyIpv4(),
				Port.tcp(80),
				'http (registry redirects, api ALB without a domain)'
			)
		}

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

		// M3 hardening #1: the job task role itself gets no S3 permission (below). It may only
		// `sts:AssumeRole` into this role, whose OWN ceiling is `deliverables/*` + `delivery-source/*`
		// — apps/job then narrows that further with an inline session policy built from its own
		// `JOB_ID` (`ARTIFACTS_ROLE_ARN`, packages/harness/src/job/delivery/artifacts.ts), so one
		// job's credentials can put objects only under its own prefix/key, never another job's.
		this.jobArtifactsRole = new Role(this, 'JobArtifactsRole', {
			roleName: `mf-job-artifacts-${environment.name}`,
			assumedBy: new ArnPrincipal(this.jobTaskDefinition.taskRole.roleArn),
			description: 'Per-job S3 uploads, session-policy-scoped by the job to its own prefix/key',
			maxSessionDuration: Duration.hours(1),
		})

		// Egress allowlist proxy: tinyproxy, FilterDefaultDeny, domains in apps/job/proxy/filter
		// (npm, GitHub, Anthropic). Flag off: a sidecar sharing localhost with the job container
		// (awsvpc). Flag on (C1): its OWN Fargate service + SG — see the fence block below.
		const proxyPort = 8888
		const proxyImage = ContainerImage.fromAsset(`${repositoryRoot}/apps/job/proxy`)
		const proxyHealthCheck = {
			command: ['CMD-SHELL', `nc -z 127.0.0.1 ${proxyPort} || exit 1`],
			interval: Duration.seconds(10),
			retries: 3,
			startPeriod: Duration.seconds(5),
		}
		const proxy = egressFence
			? undefined
			: this.jobTaskDefinition.addContainer('egress-proxy', {
					image: proxyImage,
					essential: true,
					memoryReservationMiB: 64,
					logging: LogDrivers.awsLogs({ logGroup: jobLogGroup, streamPrefix: 'proxy' }),
					healthCheck: proxyHealthCheck,
				})

		// MARK: C1 egress fence (jobs.egressFence, default OFF — nothing below exists in a normal
		// synth). The proxy moves out of the task so the network can tell proxy traffic from a
		// worker that ignores HTTPS_PROXY; the job SG (deny-by-default above) may then reach ONLY:
		//   proxy SG :8888           — the single route to the internet (allowlist enforced there)
		//   interface endpoints :443 — the direct-to-AWS NO_PROXY set (Secrets Manager, STS, ECS,
		//                              CodeBuild) plus what Fargate itself needs (ECR api/dkr, logs)
		//   S3 prefix list :443      — gateway endpoint: artifact uploads + ECR image layers
		// The api ALB egress rule lives in mf-<env> (web-stack owns the ALB; it depends on this
		// stack, so the rule cannot be added here without a cycle).
		let egressProxyHost: string | undefined
		if (egressFence) {
			const endpointsSecurityGroup = new SecurityGroup(this, 'JobEndpointsSecurityGroup', {
				vpc: this.vpc,
				description: 'VPC interface endpoints for fenced build-job tasks (C1)',
				allowAllOutbound: false,
			})
			endpointsSecurityGroup.addIngressRule(
				this.jobSecurityGroup,
				Port.tcp(443),
				'fenced job tasks'
			)
			const endpointServices: [string, InterfaceVpcEndpointAwsService][] = [
				['SecretsManager', InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
				['Sts', InterfaceVpcEndpointAwsService.STS],
				['Ecs', InterfaceVpcEndpointAwsService.ECS],
				['CodeBuild', InterfaceVpcEndpointAwsService.CODEBUILD],
				['Logs', InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
				['EcrApi', InterfaceVpcEndpointAwsService.ECR],
				['EcrDocker', InterfaceVpcEndpointAwsService.ECR_DOCKER],
			]
			for (const [name, service] of endpointServices) {
				this.vpc.addInterfaceEndpoint(`JobEndpoint${name}`, {
					service,
					securityGroups: [endpointsSecurityGroup],
					subnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
				})
			}
			this.vpc.addGatewayEndpoint('JobS3Endpoint', {
				service: GatewayVpcEndpointAwsService.S3,
				subnets: [{ subnetType: SubnetType.PRIVATE_WITH_EGRESS }],
			})

			// The proxy's own SG is the one place with real internet egress; ingress only from jobs
			const proxySecurityGroup = new SecurityGroup(this, 'EgressProxySecurityGroup', {
				vpc: this.vpc,
				description: 'Egress allowlist proxy for build jobs (C1) - the single way out',
				allowAllOutbound: false,
			})
			proxySecurityGroup.addEgressRule(Peer.anyIpv4(), Port.tcp(443), 'allowlisted https')
			proxySecurityGroup.addEgressRule(Peer.anyIpv4(), Port.tcp(80), 'allowlisted http')
			proxySecurityGroup.addIngressRule(
				this.jobSecurityGroup,
				Port.tcp(proxyPort),
				'build job tasks'
			)
			this.jobSecurityGroup.addEgressRule(
				proxySecurityGroup,
				Port.tcp(proxyPort),
				'egress proxy - the only internet route'
			)
			this.jobSecurityGroup.addEgressRule(
				endpointsSecurityGroup,
				Port.tcp(443),
				'AWS APIs via VPC interface endpoints (NO_PROXY set)'
			)
			if (environment.jobs.s3PrefixListId) {
				this.jobSecurityGroup.addEgressRule(
					Peer.prefixList(environment.jobs.s3PrefixListId),
					Port.tcp(443),
					'S3 gateway endpoint (artifact uploads + ECR image layers)'
				)
			}

			// Stable in-VPC DNS for the proxy: egress-proxy.mf-<env>.internal via Cloud Map
			const namespaceName = `mf-${environment.name}.internal`
			this.jobsCluster.addDefaultCloudMapNamespace({ name: namespaceName })
			const proxyTaskDefinition = new FargateTaskDefinition(this, 'EgressProxyTaskDefinition', {
				family: `mf-egress-proxy-${environment.name}`,
				cpu: 256,
				memoryLimitMiB: 512,
				runtimePlatform: {
					cpuArchitecture: CpuArchitecture.X86_64,
					operatingSystemFamily: OperatingSystemFamily.LINUX,
				},
			})
			proxyTaskDefinition.addContainer('egress-proxy', {
				image: proxyImage,
				essential: true,
				portMappings: [{ containerPort: proxyPort }],
				logging: LogDrivers.awsLogs({ logGroup: jobLogGroup, streamPrefix: 'proxy' }),
				healthCheck: proxyHealthCheck,
				// Fenced job→api reports ride this proxy (the deny-by-default job SG has no route to
				// the internet-facing ALB's public IPs), so the api host joins the static allowlist
				// (`apps/job/proxy/filter`) at container start — the entrypoint appends these lines.
				environment: { FILTER_ALLOW_EXTRA: environment.domain!.apiDomainName },
			})
			new FargateService(this, 'EgressProxyService', {
				cluster: this.jobsCluster,
				taskDefinition: proxyTaskDefinition,
				securityGroups: [proxySecurityGroup],
				vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
				desiredCount: 1,
				// A single shared proxy: a redeploy may stop it briefly (npm/git retries in the jobs
				// ride it out); scale desiredCount before scaling job concurrency.
				minHealthyPercent: 0,
				cloudMapOptions: { name: 'egress-proxy' },
			})
			egressProxyHost = `egress-proxy.${namespaceName}`
		}

		// MARK: ECS Express Mode delivery (M5). App Runner stopped taking new customers and is not in
		// eu-north-1; its replacement, ECS Express Mode, takes a PREBUILT image (ECR URI) and returns
		// a managed HTTPS URL. So delivery is two stages, both created here and driven at runtime by
		// the job (one build + one service per delivery):
		//   1. build — a CodeBuild project builds the api image from the delivery's S3 source zip
		//      (no GitHub creds in CodeBuild) and pushes it to the ECR repo below.
		//   2. deploy — CreateExpressGatewayService from that image, passing the execution +
		//      infrastructure roles below. The customer api needs no AWS access in the preview, so the
		//      execution role carries only the managed task-execution policy (pull image + write logs).

		// ECR repository for built customer images. Untagged images (superseded builds) expire; the
		// per-job tag is the service name, kept until the preview is torn down out-of-band.
		this.deliverablesRepository = new Repository(this, 'DeliverablesRepository', {
			repositoryName: `mf-deliverables-${environment.name}`,
			removalPolicy,
			emptyOnDelete: !isLive,
			lifecycleRules: [{ tagStatus: TagStatus.UNTAGGED, maxImageAge: Duration.days(14) }],
		})

		// CloudWatch log group for the ECS Express preview containers. The name matches what apps/job
		// derives from ENV (`/mf/<env>/express`); the execution role's managed policy grants the
		// log-stream writes.
		const expressLogGroup = new LogGroup(this, 'ExpressLogGroup', {
			logGroupName: `/mf/${environment.name}/express`,
			retention: RetentionDays.TWO_WEEKS,
			removalPolicy,
		})

		// CodeBuild project: privileged (docker), S3 source (the delivery uploads the built repo as a
		// zip), inline buildspec that builds apps/api/Dockerfile and pushes `$ECR_REPOSITORY_URI:$IMAGE_TAG`.
		// CDK auto-creates its service role; grant it ECR push + read the source bucket (logs are auto).
		this.deliveryBuildProject = new Project(this, 'DeliveryBuildProject', {
			projectName: `mf-delivery-build-${environment.name}`,
			source: Source.s3({ bucket: this.artifactsBucket, path: 'delivery-source/source.zip' }),
			environment: { buildImage: LinuxBuildImage.STANDARD_7_0, privileged: true },
			logging: { cloudWatch: { logGroup: jobLogGroup } },
			buildSpec: BuildSpec.fromObject({
				version: '0.2',
				phases: {
					pre_build: {
						commands: [
							'REGISTRY="${ECR_REPOSITORY_URI%/*}"',
							'aws ecr get-login-password --region "$AWS_DEFAULT_REGION" | docker login --username AWS --password-stdin "$REGISTRY"',
						],
					},
					build: {
						commands: [
							'docker build -t "$ECR_REPOSITORY_URI:$IMAGE_TAG" -f apps/api/Dockerfile .',
						],
					},
					post_build: { commands: ['docker push "$ECR_REPOSITORY_URI:$IMAGE_TAG"'] },
				},
			}),
		})
		// Per-job source zips live under this prefix (see `uploadSource`); the override reads them.
		// This one prefixed grant is the ONLY artifacts-bucket access the build role gets: it already
		// emits the bucket-level s3:GetBucket*/s3:List* on the bare bucket ARN that an S3 source
		// needs, plus s3:GetObject* on `delivery-source/*`. Never add an unscoped
		// `grantRead(this.deliveryBuildProject)` — `objectsKeyPattern` defaults to `'*'`, which would
		// hand a privileged CodeBuild container running AI-authored build content read access to
		// `deliverables/<jobId>/` for EVERY job in the bucket (audit 2026-08-31, P0-1).
		// infra/test/security-baseline.test.ts pins this.
		this.artifactsBucket.grantRead(this.deliveryBuildProject, 'delivery-source/*')
		this.deliverablesRepository.grantPullPush(this.deliveryBuildProject)

		// Task-execution role for the Express service: pull the ECR image, write container logs.
		this.expressExecutionRole = new Role(this, 'ExpressExecutionRole', {
			roleName: `mf-express-execution-${environment.name}`,
			assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
			description: 'Task-execution role of customer ECS Express preview services (M5)',
			managedPolicies: [
				ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
			],
		})

		// Infrastructure role ECS Express assumes to provision the managed ALB/target groups per
		// service. The managed policy name is post-cutoff (verified against the AWS docs 2026-08-28) —
		// synth only builds its ARN, so this is unverified until the first live deploy.
		this.expressInfrastructureRole = new Role(this, 'ExpressInfrastructureRole', {
			roleName: `mf-express-infra-${environment.name}`,
			assumedBy: new ServicePrincipal('ecs.amazonaws.com'),
			description: 'Infrastructure role for customer ECS Express preview services (M5)',
			managedPolicies: [
				ManagedPolicy.fromAwsManagedPolicyName(
					// Service-role-scoped, capital "For" (verified against IAM 2026-08-28; the ECS docs
					// print it as ".../AmazonECSInfrastructureRoleforExpressGatewayServices", which 404s)
					'service-role/AmazonECSInfrastructureRoleForExpressGatewayServices'
				),
			],
		})

		// MARK: Preview object storage (docs/PREVIEW-RESOURCES.md)
		// A delivered app that takes uploads needs somewhere to put them. One shared bucket, one
		// prefix per job, and — the part that matters — one IAM role per job scoped to that prefix,
		// created by the api at delivery time. ECS has no session-tag/ABAC passthrough for task
		// roles (containers-roadmap#2426), so a single shared role could only be scoped to
		// `preview/*`: every delivered app able to read every other's objects, separated by nothing
		// but convention. Per-job roles make IAM the fence instead.
		this.previewBucket = new Bucket(this, 'PreviewBucket', {
			encryption: BucketEncryption.S3_MANAGED,
			blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
			enforceSSL: true,
			removalPolicy: RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
			lifecycleRules: [
				// Preview objects belong to a preview. Nothing here is the customer's system of
				// record — the delivered repo is — so they expire rather than accumulate forever.
				{ id: 'expire-preview-objects', expiration: Duration.days(90) },
			],
		})

		// The ceiling on every per-app role the api mints. A permissions boundary caps the EFFECTIVE
		// permissions of a role regardless of what policy is attached to it, so even a bug in
		// previewStorageService cannot produce a role that reaches outside this bucket.
		this.previewRoleBoundary = new ManagedPolicy(this, 'PreviewRoleBoundary', {
			managedPolicyName: `mf-preview-boundary-${environment.name}`,
			description: 'Ceiling for per-delivery preview app roles: objects in the preview bucket only',
			statements: [
				new PolicyStatement({
					actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
					resources: [`${this.previewBucket.bucketArn}/preview/*`],
				}),
				new PolicyStatement({
					actions: ['s3:ListBucket'],
					resources: [this.previewBucket.bucketArn],
				}),
			],
		})

		this.previewAppSecurityGroup = new SecurityGroup(this, 'PreviewAppSecurityGroup', {
			vpc: this.vpc,
			description: 'Delivered preview apps (ECS Express tasks)',
			allowAllOutbound: true,
		})
		// The Express-managed load balancer fronts these tasks and its own group is not knowable
		// here, so ingress is scoped to the container port from inside the VPC rather than to a
		// security group. That is a far narrower opening than the alternative it replaces.
		this.previewAppSecurityGroup.addIngressRule(
			Peer.ipv4(this.vpc.vpcCidrBlock),
			Port.tcp(8080),
			'Express-managed load balancer -> delivered app'
		)
		// The delivered app reaching its OWN provisioned database (docs/DELIVERED-DB.md). Scoped to
		// this group alone: the build job is deliberately NOT included, so the M3 invariant that
		// keeps the job off the database survives — `security-baseline.test.ts` asserts it.
		this.databaseSecurityGroup.addIngressRule(
			this.previewAppSecurityGroup,
			Port.tcp(5432),
			'delivered preview app -> its own provisioned database'
		)

		// The job container: apps/job/Dockerfile (harness + golden template). `JOB_ID`, the per-job
		// `JOB_TOKEN`, `API_URL` and the final `NO_PROXY` (this list + the api host, `JOB_NO_PROXY`
		// on the api — the ALB lives in mf-<env>, which depends on this stack; with the C1 fence on
		// the api host is NOT in it: reports ride the proxy instead) are set per run by
		// the api's ecs:RunTask override. Only the ECS credential/metadata endpoints, Secrets
		// Manager, the artifacts bucket, ECS + CodeBuild (M5 delivery) and the api bypass the proxy
		// (NO_PROXY, exact hosts — a wildcard `.amazonaws.com` would let any AWS-hosted endpoint skip
		// the allowlist); everything else, including every other AWS service, must pass the allowlist.
		// (The job never talks to ECR directly — CodeBuild builds and pushes the image.)
		this.jobNoProxyHosts = [
			'127.0.0.1',
			'localhost',
			'169.254.170.2',
			'169.254.169.254',
			`secretsmanager.${this.region}.amazonaws.com`,
			// sts:AssumeRole into jobArtifactsRole (M3 hardening #1) — same direct-to-AWS-API bypass
			// as Secrets Manager above, never a customer-reachable host.
			`sts.${this.region}.amazonaws.com`,
			`${this.artifactsBucket.bucketName}.s3.${this.region}.amazonaws.com`,
			`${this.artifactsBucket.bucketName}.s3.amazonaws.com`,
			`ecs.${this.region}.amazonaws.com`,
			`codebuild.${this.region}.amazonaws.com`,
		]
		const job = this.jobTaskDefinition.addContainer('job', {
			image: ContainerImage.fromAsset(repositoryRoot, { file: 'apps/job/Dockerfile' }),
			essential: true,
			logging: LogDrivers.awsLogs({ logGroup: jobLogGroup, streamPrefix: 'job' }),
			environment: {
				ENV: environment.name,
				ARTIFACTS_BUCKET: this.artifactsBucket.bucketName,
				// M3 hardening #1: role the job assumes (session-policy-scoped to its own JOB_ID) to
				// upload — the task role itself has no S3 permission (see the job task role MARK below)
				ARTIFACTS_ROLE_ARN: this.jobArtifactsRole.roleArn,
				ANTHROPIC_API_KEY_SECRET_ARN: this.secrets['anthropic-api-key'].secretArn,
				// M5 delivery: GitHub App installation tokens (repo push) + ECS Express preview + bundle
				GITHUB_APP_PRIVATE_KEY_SECRET_ARN: this.secrets['github-app-key'].secretArn,
				...(environment.githubDelivery
					? { GITHUB_APP_INSTALLATION_ID: String(environment.githubDelivery.installationId) }
					: {}),
				...(environment.githubDelivery?.appId
					? { GITHUB_APP_ID: environment.githubDelivery.appId }
					: {}),
				...(environment.jobs.deliveryDryRun ? { DELIVERY_DRY_RUN: '1' } : {}),
				// M5 ECS Express: build the image (CodeBuild → ECR) then CreateExpressGatewayService
				ECR_REPOSITORY_URI: this.deliverablesRepository.repositoryUri,
				CODEBUILD_PROJECT: this.deliveryBuildProject.projectName,
				EXPRESS_EXECUTION_ROLE_ARN: this.expressExecutionRole.roleArn,
				// Our own network configuration for the delivered service, so it lands in a security
				// group we can write RDS rules against (see PreviewAppSecurityGroup).
				EXPRESS_SECURITY_GROUP_ID: this.previewAppSecurityGroup.securityGroupId,
				EXPRESS_SUBNET_IDS: this.vpc
					.selectSubnets({ subnetType: SubnetType.PRIVATE_WITH_EGRESS })
					.subnetIds.join(','),
				EXPRESS_INFRASTRUCTURE_ROLE_ARN: this.expressInfrastructureRole.roleArn,
				ECS_CLUSTER: this.jobsCluster.clusterName,
				// The preview api verifies tokens against our api (it publishes a JWKS); only known
				// here with a custom domain — without it the deploy step is skipped (deployUrl null)
				...(environment.auth.issuer ? { PREVIEW_AUTH_ISSUER: environment.auth.issuer } : {}),
				HTTP_PROXY: `http://${egressProxyHost ?? '127.0.0.1'}:${proxyPort}`,
				HTTPS_PROXY: `http://${egressProxyHost ?? '127.0.0.1'}:${proxyPort}`,
				NO_PROXY: this.jobNoProxyHosts.join(','),
				NODE_USE_ENV_PROXY: '1',
			},
		})
		// Sidecar mode only: with the fence on the proxy is its own always-on service, so there is
		// no in-task dependency to wait for (a job whose proxy is unreachable fails on first fetch).
		if (proxy) {
			job.addContainerDependencies({
				container: proxy,
				condition: ContainerDependencyCondition.HEALTHY,
			})
		}

		// MARK: Job task role — reviewed M9, narrowed by M3 hardening, extended M5. The container
		// runs customer-driven code, so it gets exactly what apps/job needs today:
		//   secretsmanager:GetSecretValue on anthropic-api-key — the build itself (Agent SDK workers)
		//   secretsmanager:GetSecretValue on github-app-key    — M5: mint installation tokens to push the customer repo.
		//     The M9 review removed this grant expecting a short-lived per-job token; that needs a
		//     GitHub App (TODO-EXTERNAL), so the org token is BACK for v1. apps/job reads it once at
		//     start-up and strips it from the environment the sandbox (workers, npm scripts) sees;
		//     it is still reachable by code running in the job process — accepted until the App exists.
		//   sts:AssumeRole on jobArtifactsRole only            — that role (not this one) carries
		//     s3:PutObject*/Abort* on the artifacts bucket, ceiling-scoped to deliverables/* +
		//     delivery-source/*; apps/job narrows it further per job with an inline session policy
		//     built from its own JOB_ID (M3 hardening #1 — a job can put objects only under its own
		//     prefix/key, never another job's; versioning still keeps any prior copy either way).
		//   codebuild:StartBuild/BatchGetBuilds on the project — M5: build + push the customer image to ECR.
		//     Resource-scoped to the one delivery project, so the job can start no other build.
		//   ecs:CreateExpressGatewayService/DescribeExpressGatewayService — M5: preview service from that
		//     image. Create only with the `Service=mf-delivery` request tag, Describe only on services
		//     carrying it: the job can touch preview services, never anything else in the account.
		//   iam:PassRole on the Express execution + infrastructure roles (to ECS) and the CodeBuild
		//     service role (to CodeBuild) — required to create the service / run the build.
		// The job row + events go through the api's `/internal/jobs/:id` endpoint with a per-job
		// token (RunTask override), so there is no database grant and no 5432 rule any more
		// (docs/M3-REVIEW.md #18). Never: Stripe keys, the auth signing key, ecr:* directly (CodeBuild
		// pushes) or logs:* (the execution role writes logs). Secrets reach the container as ARNs.
		this.secrets['anthropic-api-key'].grantRead(this.jobTaskDefinition.taskRole)
		this.secrets['github-app-key'].grantRead(this.jobTaskDefinition.taskRole)
		// jobArtifactsRole's own ceiling — the runtime session policy (apps/job) narrows it to one
		// job's prefix/key; grantPut, not grantWrite, so even a full job's worth of access can
		// upload but never delete or overwrite-by-delete.
		this.artifactsBucket.grantPut(this.jobArtifactsRole, 'deliverables/*')
		this.artifactsBucket.grantPut(this.jobArtifactsRole, 'delivery-source/*')
		this.jobArtifactsRole.grantAssumeRole(this.jobTaskDefinition.taskRole)
		// CodeBuild: resource-scoped to the one delivery project (no tag fence needed).
		this.jobTaskDefinition.taskRole.addToPrincipalPolicy(
			new PolicyStatement({
				sid: 'CodeBuildDeliveryImage',
				actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds'],
				resources: [this.deliveryBuildProject.projectArn],
			})
		)
		// ECS Express has no grant* helpers. Create is fenced by the `Service=mf-delivery` request tag
		// the job sets on every service; Describe by that tag on the resource.
		// CreateExpressGatewayService applies the request tags (Service=mf-delivery + the per-order
		// Customer=<slug> fence) via a distinct TagResource authorization, so the role needs
		// ecs:TagResource too — fenced by the SAME aws:RequestTag/Service (the service has no
		// existing tags at create time, so aws:ResourceTag would not yet match). Without it the
		// deploy step fails "not authorized to perform: ecs:TagResource" and delivers no live URL.
		this.jobTaskDefinition.taskRole.addToPrincipalPolicy(
			new PolicyStatement({
				sid: 'EcsExpressCreatePreviewServices',
				actions: ['ecs:CreateExpressGatewayService', 'ecs:TagResource'],
				resources: ['*'],
				conditions: { StringEquals: { 'aws:RequestTag/Service': 'mf-delivery' } },
			})
		)
		this.jobTaskDefinition.taskRole.addToPrincipalPolicy(
			new PolicyStatement({
				sid: 'EcsExpressDescribePreviewServices',
				actions: ['ecs:DescribeExpressGatewayService'],
				resources: ['*'],
				conditions: { StringEquals: { 'aws:ResourceTag/Service': 'mf-delivery' } },
			})
		)
		// PassRole: the two Express roles to ECS, and the CodeBuild service role to CodeBuild.
		this.jobTaskDefinition.taskRole.addToPrincipalPolicy(
			new PolicyStatement({
				sid: 'PassExpressRoles',
				actions: ['iam:PassRole'],
				resources: [this.expressExecutionRole.roleArn, this.expressInfrastructureRole.roleArn],
				conditions: {
					StringEquals: {
						'iam:PassedToService': ['ecs-tasks.amazonaws.com', 'ecs.amazonaws.com'],
					},
				},
			})
		)
		this.jobTaskDefinition.taskRole.addToPrincipalPolicy(
			new PolicyStatement({
				sid: 'PassCodeBuildRole',
				actions: ['iam:PassRole'],
				resources: [this.deliveryBuildProject.role!.roleArn],
				conditions: { StringEquals: { 'iam:PassedToService': 'codebuild.amazonaws.com' } },
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
		new CfnOutput(this, 'DeliverablesRepositoryUri', {
			value: this.deliverablesRepository.repositoryUri,
			exportName: 'ecr-deliverables-uri',
		})
		new CfnOutput(this, 'DeliveryBuildProjectName', {
			value: this.deliveryBuildProject.projectName,
			exportName: 'codebuild-delivery-project',
		})
		new CfnOutput(this, 'ExpressExecutionRoleArn', {
			value: this.expressExecutionRole.roleArn,
			exportName: 'express-execution-role-arn',
		})
		new CfnOutput(this, 'ExpressInfrastructureRoleArn', {
			value: this.expressInfrastructureRole.roleArn,
			exportName: 'express-infrastructure-role-arn',
		})
		new CfnOutput(this, 'JobSecurityGroupId', {
			value: this.jobSecurityGroup.securityGroupId,
			exportName: 'ecs-job-security-group-id',
		})
	}
}
