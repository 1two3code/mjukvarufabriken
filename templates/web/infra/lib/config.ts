export type EnvironmentName = 'dev' | 'live'

export type DomainConfig = {
	/** Custom domain for the SPA, e.g. `app.example.com` */
	appDomainName: string
	/** Custom domain for the API, e.g. `api.example.com` */
	apiDomainName: string
	/** Route 53 hosted zone that owns both domains (A records are created there) */
	hostedZoneId: string
	hostedZoneName: string
	/** ACM certificate for the SPA — MUST be issued in us-east-1 (CloudFront requirement) */
	cloudFrontCertificateArn: string
	/** ACM certificate for the API — issued in the stack's region */
	apiCertificateArn: string
}

export type EnvironmentConfig = {
	name: EnvironmentName
	/**
	 * AWS account id and region. Read from the environment so no account numbers live in git.
	 * When unset the stacks are environment-agnostic, which keeps `cdk synth` free of AWS lookups.
	 */
	account?: string
	region?: string
	auth: { jwksUrl: string; issuer: string; audience: string }
	/**
	 * Optional custom domains. Without it the app is served on the CloudFront default domain
	 * and the API on the load balancer DNS name over plain HTTP — fine for a first deploy.
	 */
	domain?: DomainConfig
	/** Provision an OpenSearch domain in the resources stack (costs money even when idle) */
	enableOpenSearch?: boolean
}

type Config = {
	serviceName: string
	environments: EnvironmentConfig[]
}

const account = process.env.CDK_DEFAULT_ACCOUNT
const region = process.env.CDK_DEFAULT_REGION

const auth = {
	jwksUrl: 'https://auth.example.com/.well-known/jwks.json',
	issuer: 'https://auth.example.com',
	audience: 'template-web',
}

export const config: Config = {
	serviceName: 'web',
	environments: [
		{ name: 'dev', account, region, auth },
		{ name: 'live', account, region, auth },
	],
}
