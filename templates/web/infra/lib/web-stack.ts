import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager'
import {
	AllowedMethods,
	Distribution,
	HeadersFrameOption,
	HeadersReferrerPolicy,
	ResponseHeadersPolicy,
	ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront'
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins'
import { Cluster, ContainerImage } from 'aws-cdk-lib/aws-ecs'
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns'
import { ApplicationProtocol } from 'aws-cdk-lib/aws-elasticloadbalancingv2'
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
	/** Absolute path to the built SPA (apps/app/dist/<env>) */
	appDistPath: string
	/** Absolute path to the repository root (Docker build context) */
	repositoryRoot: string
}

export class WebStack extends Stack {
	constructor(scope: Construct, id: string, props: WebStackProps) {
		super(scope, id, props)

		const { environment, resources, appDistPath, repositoryRoot } = props
		const { domain } = environment
		const isLive = environment.name === 'live'

		const hostedZone: IHostedZone | undefined = domain
			? HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
					hostedZoneId: domain.hostedZoneId,
					zoneName: domain.hostedZoneName,
				})
			: undefined

		// MARK: App — S3 + CloudFront
		const bucket = new Bucket(this, 'AppBucket', {
			blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
			removalPolicy: isLive ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
			autoDeleteObjects: !isLive,
		})

		const responseHeadersPolicy = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
			securityHeadersBehavior: {
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

		const distribution = new Distribution(this, 'AppDistribution', {
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
			...(domain && {
				domainNames: [domain.appDomainName],
				certificate: Certificate.fromCertificateArn(
					this,
					'AppCertificate',
					domain.cloudFrontCertificateArn
				),
			}),
		})

		new BucketDeployment(this, 'AppDeployment', {
			sources: [Source.asset(appDistPath)],
			destinationBucket: bucket,
			distribution,
			distributionPaths: ['/*'],
		})

		const appUrl = domain
			? `https://${domain.appDomainName}`
			: `https://${distribution.distributionDomainName}`

		// MARK: API — ECS Fargate behind an ALB
		const cluster = new Cluster(this, 'Cluster', { vpc: resources.vpc })

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
				environment: {
					ENV: environment.name,
					LOG_LEVEL: isLive ? 'warn' : 'info',
					APP_URL: appUrl,
					AUTH_JWKS_URL: environment.auth.jwksUrl,
					AUTH_ISSUER: environment.auth.issuer,
					AUTH_AUDIENCE: environment.auth.audience,
					ITEMS_TABLE: resources.itemsTable.tableName,
					ATTACHMENTS_BUCKET: resources.attachmentsBucket.bucketName,
					...(resources.openSearch && { OPENSEARCH_ENDPOINT: resources.openSearch.domainEndpoint }),
				},
			},
		})
		api.targetGroup.configureHealthCheck({ path: '/health', interval: Duration.seconds(30) })

		// Least-privilege access to the shared resources
		const taskRole = api.taskDefinition.taskRole
		resources.itemsTable.grantReadWriteData(taskRole)
		resources.attachmentsBucket.grantReadWrite(taskRole)
		resources.openSearch?.grantReadWrite(taskRole)

		// MARK: DNS
		if (domain && hostedZone) {
			new ARecord(this, 'AppRecord', {
				zone: hostedZone,
				recordName: domain.appDomainName,
				target: RecordTarget.fromAlias(new CloudFrontTarget(distribution)),
			})
			new ARecord(this, 'ApiRecord', {
				zone: hostedZone,
				recordName: domain.apiDomainName,
				target: RecordTarget.fromAlias(new LoadBalancerTarget(api.loadBalancer)),
			})
		}

		// MARK: Outputs
		new CfnOutput(this, 'AppUrl', { value: appUrl, exportName: 'app-url' })
		new CfnOutput(this, 'ApiUrl', {
			value: domain
				? `https://${domain.apiDomainName}`
				: `http://${api.loadBalancer.loadBalancerDnsName}`,
			exportName: 'api-url',
		})
	}
}
