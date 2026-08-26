import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import {
	AllowedMethods,
	Distribution,
	HeadersFrameOption,
	HeadersReferrerPolicy,
	ResponseHeadersPolicy,
	ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront'
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins'
import { Vpc } from 'aws-cdk-lib/aws-ec2'
import { Cluster, ContainerImage } from 'aws-cdk-lib/aws-ecs'
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns'
import { BlockPublicAccess, Bucket } from 'aws-cdk-lib/aws-s3'
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment'

import type { StackProps } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import type { EnvironmentConfig } from './config.ts'

export interface WebStackProps extends StackProps {
	environment: EnvironmentConfig
	/** Absolute path to the built SPA (apps/app/dist/<env>) */
	appDistPath: string
	/** Absolute path to the repository root (Docker build context) */
	repositoryRoot: string
}

export class WebStack extends Stack {
	constructor(scope: Construct, id: string, props: WebStackProps) {
		super(scope, id, props)

		const { environment, appDistPath, repositoryRoot } = props
		const isLive = environment.name === 'live'

		// MARK: API — ECS Fargate behind an ALB
		const vpc = new Vpc(this, 'Vpc', { maxAzs: 2, natGateways: 1 })
		const cluster = new Cluster(this, 'Cluster', { vpc })

		const api = new ApplicationLoadBalancedFargateService(this, 'Api', {
			cluster,
			cpu: 512,
			memoryLimitMiB: 1024,
			desiredCount: isLive ? 2 : 1,
			minHealthyPercent: 50,
			circuitBreaker: { rollback: true },
			publicLoadBalancer: true,
			taskImageOptions: {
				image: ContainerImage.fromAsset(repositoryRoot, { file: 'apps/api/Dockerfile' }),
				containerPort: 80,
				environment: {
					ENV: environment.name,
					LOG_LEVEL: isLive ? 'warn' : 'info',
					APP_URL: environment.appUrl,
					AUTH_JWKS_URL: environment.auth.jwksUrl,
					AUTH_ISSUER: environment.auth.issuer,
					AUTH_AUDIENCE: environment.auth.audience,
				},
			},
		})
		api.targetGroup.configureHealthCheck({ path: '/health', interval: Duration.seconds(30) })

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
						"default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' https:",
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
		})

		new BucketDeployment(this, 'AppDeployment', {
			sources: [Source.asset(appDistPath)],
			destinationBucket: bucket,
			distribution,
			distributionPaths: ['/*'],
		})

		// MARK: Outputs
		new CfnOutput(this, 'ApiUrl', {
			value: `http://${api.loadBalancer.loadBalancerDnsName}`,
			exportName: `${environment.name}-api-url`,
		})
		new CfnOutput(this, 'AppUrl', {
			value: `https://${distribution.distributionDomainName}`,
			exportName: `${environment.name}-app-url`,
		})
	}
}
