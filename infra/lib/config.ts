export type EnvironmentName = 'dev' | 'live'

export type DomainConfig = {
	/** Custom domain for the public site, e.g. `mjukvarufabriken.se` */
	siteDomainName: string
	/** Custom domain for the customer portal, e.g. `portal.mjukvarufabriken.se` */
	portalDomainName: string
	/** Custom domain for the API, e.g. `api.example.com` */
	apiDomainName: string
	/** Route 53 hosted zone that owns both domains (A records are created there) */
	hostedZoneId: string
	hostedZoneName: string
	/** ACM certificate covering both SPA domains — MUST be issued in us-east-1 (CloudFront requirement) */
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
	 * Optional custom domains. Without it the SPAs are served on CloudFront default domains
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

// No account numbers in git. Region defaults to Stockholm; without an account the stacks stay
// environment-agnostic so `cdk synth` runs offline.
const account = process.env.CDK_DEFAULT_ACCOUNT
const region = account ? (process.env.CDK_DEFAULT_REGION ?? 'eu-north-1') : undefined

// Placeholder until the magic-link auth issuer exists (M6)
const auth = {
	jwksUrl: 'https://auth.mjukvarufabriken.se/.well-known/jwks.json',
	issuer: 'https://auth.mjukvarufabriken.se',
	audience: 'mjukvarufabriken',
}

export const config: Config = {
	serviceName: 'mf',
	environments: [
		{ name: 'dev', account, region, auth },
		{ name: 'live', account, region, auth },
	],
}
