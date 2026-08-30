import { InstanceClass, InstanceSize, InstanceType } from 'aws-cdk-lib/aws-ec2'

export type EnvironmentName = 'dev' | 'qa' | 'live'

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
	/**
	 * "Sign in with GitHub" (M6): the OAuth App's client id (`GITHUB_OAUTH_CLIENT_ID`); the client
	 * secret lives in the `github-oauth-client-secret` secret. Unset until the OAuth App exists
	 * (TODO-EXTERNAL) — the api then answers 404 on `/bff/auth/github` and the portal keeps the
	 * button hidden (`VITE_GITHUB_SIGNIN`).
	 */
	githubOAuth?: { clientId: string }
	/**
	 * M5 delivery via the GitHub App's installation tokens (repo create/push/transfer). `appId`
	 * and `installationId` are public-ish config; the App private key lives in the
	 * `github-app-key` secret. `appId` unset → delivery's repo step fails closed until it is set.
	 */
	githubDelivery?: { appId?: string; installationId: number }
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
	jobs: {
		cpu: number
		memoryMiB: number
		/** M5: log GitHub / ECS Express / S3 delivery calls instead of making them (until the roles are ready) */
		deliveryDryRun?: boolean
	}
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
	/** `owner/name` of the GitHub repository whose Actions deploy (github-deploy stack trust) */
	githubRepository: string
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
	githubRepository: '1two3code/mjukvarufabriken',
	environments: [
		{
			name: 'dev',
			account,
			region,
			auth: { ...auth, issuer: 'https://api.dev.mjukvaruhuset.se' },
			adminEmails: ['hasse.lofgren@outlook.com'],
			// "Sign in with GitHub" (M6). Client id is public; the client secret lives in the
			// `github-oauth-client-secret` secret. Note: an `Iv23li…` prefix is a GitHub *App*
			// (same web sign-in endpoints as an OAuth App; needs the "Email addresses: read" account
			// permission for the `user:email` fetch).
			githubOAuth: { clientId: 'Iv23liGn1P0xZHYqiBYa' },
			// GitHub App install for delivery (id 157166357, 2026-08-28). `appId` pending — set it
			// (the App's numeric App ID, not the client id) to enable the live repo push.
			githubDelivery: { appId: '4746145', installationId: 157185356 },
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
			jobs: { cpu: 2048, memoryMiB: 4096 }, // deliveryDryRun off 2026-08-28 — dev delivers for real now
			alerts: {
				jobTokensThreshold: 20_000_000,
				monthlyBudgetUsd: 150,
				natBytesOutPerHourThreshold: 2 * 1024 ** 3,
			},
		},
		{
			// qa — staging that mirrors the platform (environments.md phase 1). Deployed between dev
			// and live (dev → qa → live). Sizing/behaviour mirror dev (log email, t4g.micro, 7-day
			// backups) so qa is a cheap, safe rehearsal of a deploy; only the domains differ.
			name: 'qa',
			account,
			region,
			auth: { ...auth, issuer: 'https://api.qa.mjukvaruhuset.se' },
			adminEmails: ['hasse.lofgren@outlook.com'],
			// githubOAuth / githubDelivery are per-environment external credentials (one OAuth App and
			// one GitHub App install per env — TODO-EXTERNAL). Left unset until the qa apps exist:
			// the api then answers 404 on `/bff/auth/github` and delivery fails closed at `createRepo`.
			// `log` until a qa SES identity is set up (TODO-EXTERNAL): copy the link from the api log
			email: { transport: 'log', from: emailFrom },
			domain: {
				siteDomainName: 'qa.mjukvaruhuset.se',
				portalDomainName: 'portal.qa.mjukvaruhuset.se',
				apiDomainName: 'api.qa.mjukvaruhuset.se',
				// Same hosted zone as dev/live — qa.* records live in the mjukvaruhuset.se zone
				hostedZoneId: 'Z002863610X79ZE1B3K8F',
				hostedZoneName: 'mjukvaruhuset.se',
				// TODO-EXTERNAL: issue the qa ACM certificates (CloudFront cert in us-east-1, api cert
				// in eu-north-1) covering qa.mjukvaruhuset.se / portal.qa… / api.qa… and paste the
				// ARNs here. The placeholders below let `cdk synth` run offline but a real deploy
				// fails closed until the certs exist (CloudFront/ALB reject an unknown ARN).
				cloudFrontCertificateArn:
					'arn:aws:acm:us-east-1:814967776290:certificate/PENDING-QA-CLOUDFRONT-CERT',
				apiCertificateArn:
					'arn:aws:acm:eu-north-1:814967776290:certificate/PENDING-QA-API-CERT',
			},
			// db.t4g.micro ≈ 15 USD/month; mirrors dev — qa is a rehearsal, not production traffic
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
