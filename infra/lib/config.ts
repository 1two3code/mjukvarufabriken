import { InstanceClass, InstanceSize, InstanceType } from 'aws-cdk-lib/aws-ec2'

export type EnvironmentName = 'dev' | 'live'

export type DomainConfig = {
	/** Custom domain for the public site, e.g. `mjukvaruhuset.se` */
	siteDomainName: string
	/** Custom domain for the customer portal, e.g. `portal.mjukvaruhuset.se` */
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
	/**
	 * Token issuer settings for the api (it mints and verifies its own EdDSA tokens; the private
	 * key lives in the `auth-jwt-private-key` secret). `issuer` defaults to the api URL.
	 */
	auth: { issuer?: string; audience: string }
	/** Emails that sign in with the `admin` role (`AUTH_ADMIN_EMAILS`) */
	adminEmails: string[]
	/** Outgoing email: `ses` sends through SES, `log` only logs the message (magic link in the api log) */
	email: { transport: 'ses' | 'log'; from: string }
	/**
	 * Optional custom domains. Without it the SPAs are served on CloudFront default domains
	 * and the API on the load balancer DNS name over plain HTTP — fine for a first deploy.
	 */
	domain?: DomainConfig
	/** RDS Postgres sizing. Automated backups: 7 days dev / 30 days live (M9) */
	database: {
		instanceType: InstanceType
		allocatedStorageGb: number
		backupRetentionDays: number
	}
	/** Fargate sizing for build-job tasks (M3) */
	jobs: { cpu: number; memoryMiB: number }
	/** Alerting thresholds (M9); alarms notify `adminEmails` through the `mf-alerts-<env>` topic */
	alerts: {
		/** A single job using more tokens than this raises the token-burn alarm */
		jobTokensThreshold: number
		/** AWS Budgets monthly cost budget for the environment (80 % / 100 % notifications) */
		monthlyBudgetUsd: number
		/**
		 * NAT gateway bytes out per hour above which the cost alarm fires (a build job pulling
		 * npm/GitHub for a few minutes stays well below 1 GB)
		 */
		natBytesOutPerHourThreshold: number
	}
}

type Config = {
	serviceName: string
	environments: EnvironmentConfig[]
}

// No account numbers in git. Region defaults to Stockholm; without an account the stacks stay
// environment-agnostic so `cdk synth` runs offline.
const account = process.env.CDK_DEFAULT_ACCOUNT
const region = account ? (process.env.CDK_DEFAULT_REGION ?? 'eu-north-1') : undefined

const auth = { audience: 'mjukvaruhuset' }
const emailFrom = 'noreply@mjukvaruhuset.se'

export const config: Config = {
	serviceName: 'mf',
	environments: [
		{
			name: 'dev',
			account,
			region,
			auth: { ...auth, issuer: 'https://api.dev.mjukvaruhuset.se' },
			adminEmails: ['hasse.lofgren@outlook.com'],
			// `log` until SES production access is granted (TODO-EXTERNAL): copy the link from the api log
			email: { transport: 'log', from: emailFrom },
			domain: {
				siteDomainName: 'dev.mjukvaruhuset.se',
				portalDomainName: 'portal.dev.mjukvaruhuset.se',
				apiDomainName: 'api.dev.mjukvaruhuset.se',
				hostedZoneId: 'Z002863610X79ZE1B3K8F',
				hostedZoneName: 'mjukvaruhuset.se',
				// Issued 2026-08-26 via `aws acm request-certificate`, DNS-validated in the hosted zone
				cloudFrontCertificateArn:
					'arn:aws:acm:us-east-1:814967776290:certificate/093f6dc9-f3e2-4a9e-8f49-d9de89cb3248',
				apiCertificateArn:
					'arn:aws:acm:eu-north-1:814967776290:certificate/97331410-b5f7-4193-994e-59a9618b2091',
			},
			// db.t4g.micro ≈ 15 USD/month; smallest burstable Postgres instance
			database: {
				instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MICRO),
				allocatedStorageGb: 20,
				backupRetentionDays: 7,
			},
			jobs: { cpu: 2048, memoryMiB: 4096 },
			alerts: {
				jobTokensThreshold: 20_000_000,
				monthlyBudgetUsd: 150,
				natBytesOutPerHourThreshold: 2 * 1024 ** 3,
			},
		},
		{
			name: 'live',
			account,
			region,
			auth,
			adminEmails: ['hasse.lofgren@outlook.com'],
			email: { transport: 'ses', from: emailFrom },
			database: {
				instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.SMALL),
				allocatedStorageGb: 20,
				backupRetentionDays: 30,
			},
			jobs: { cpu: 2048, memoryMiB: 4096 },
			alerts: {
				jobTokensThreshold: 20_000_000,
				monthlyBudgetUsd: 400,
				natBytesOutPerHourThreshold: 5 * 1024 ** 3,
			},
		},
	],
}
