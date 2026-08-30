import type { App } from 'aws-cdk-lib'

export type StatusConfig = {
	/** The one Route 53 hosted zone shared by every env (infra/lib/config.ts) */
	hostedZoneId: string
	hostedZoneName: string
	/** Subdomain the status page is served on */
	domainName: string
	/** ACM certificate for `domainName`, issued out-of-band in the STACK'S region (eu-north-1 — an
	 * ALB, not CloudFront, so unlike infra/lib/config.ts's `cloudFrontCertificateArn` this one must
	 * NOT be us-east-1) */
	certificateArn: string
	/** An existing environment's VPC (infra/lib/resources-stack.ts), reused so this stack never pays
	 * for its own NAT gateway */
	vpcId: string
	availabilityZones: string[]
	/** That VPC's PUBLIC subnets — the task runs with a public IP directly (see status-stack.ts for
	 * why), so only these are needed, never the private/NAT ones */
	publicSubnetIds: string[]
	account?: string
	region?: string
}

/** Route 53 zone for mjukvaruhuset.se (see infra/lib/config.ts — shared by dev/qa/live). */
export const DEFAULT_HOSTED_ZONE_ID = 'Z002863610X79ZE1B3K8F'
export const DEFAULT_HOSTED_ZONE_NAME = 'mjukvaruhuset.se'
export const DEFAULT_DOMAIN_NAME = 'status.mjukvaruhuset.se'
// PENDING (TODO-EXTERNAL): no cert issued yet. Issue with
//   aws acm request-certificate --domain-name status.mjukvaruhuset.se --validation-method DNS --region eu-north-1
// DNS-validate the returned CNAME in the hosted zone, then pass the real ARN via
// `-c certificateArn=...` (or replace this default once issued — same pattern as
// infra/lib/config.ts's per-env cert ARNs). A real deploy with this placeholder fails closed: the
// ALB listener rejects an unknown/invalid certificate ARN.
export const DEFAULT_CERTIFICATE_ARN = 'arn:aws:acm:eu-north-1:814967776290:certificate/PENDING-STATUS-CERT'
// PENDING (TODO-EXTERNAL): reusing the dev environment's VPC (`resources-dev`,
// infra/lib/resources-stack.ts) is the intended target — read its id and public subnet ids with
//   aws cloudformation describe-stacks --stack-name resources-dev --query "Stacks[0].Outputs" (VpcId export)
//   aws ec2 describe-subnets --filters Name=vpc-id,Values=<id> Name=tag:aws-cdk:subnet-type,Values=Public
// then pass them via `-c vpcId=... -c availabilityZones=... -c publicSubnetIds=...` (or replace
// these defaults once known). A real deploy with these placeholders fails closed (no such VPC/subnet).
export const DEFAULT_VPC_ID = 'vpc-PENDING-STATUS-VPC'
export const DEFAULT_AVAILABILITY_ZONES = ['eu-north-1a', 'eu-north-1b']
export const DEFAULT_PUBLIC_SUBNET_IDS = ['subnet-PENDING-STATUS-PUBLIC-A', 'subnet-PENDING-STATUS-PUBLIC-B']

const contextString = (app: App, key: string) => {
	const value = app.node.tryGetContext(key) as unknown
	return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

const contextList = (app: App, key: string) => {
	const value = contextString(app, key)
	return value ? value.split(',').map(item => item.trim()).filter(Boolean) : undefined
}

/**
 * Everything comes from CDK context (`-c vpcId=...`) or a safe, checked-in default, so a plain
 * `cdk synth` stays offline and green — no AWS lookups at synth time.
 */
export const loadConfig = (app: App): StatusConfig => {
	const account = process.env.CDK_DEFAULT_ACCOUNT
	return {
		hostedZoneId: contextString(app, 'hostedZoneId') || DEFAULT_HOSTED_ZONE_ID,
		hostedZoneName: contextString(app, 'hostedZoneName') || DEFAULT_HOSTED_ZONE_NAME,
		domainName: contextString(app, 'domainName') || DEFAULT_DOMAIN_NAME,
		certificateArn: contextString(app, 'certificateArn') || DEFAULT_CERTIFICATE_ARN,
		vpcId: contextString(app, 'vpcId') || DEFAULT_VPC_ID,
		availabilityZones: contextList(app, 'availabilityZones') || DEFAULT_AVAILABILITY_ZONES,
		publicSubnetIds: contextList(app, 'publicSubnetIds') || DEFAULT_PUBLIC_SUBNET_IDS,
		account,
		region: account ? 'eu-north-1' : undefined,
	}
}
