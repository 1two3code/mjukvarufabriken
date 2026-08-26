export type EnvironmentName = 'dev' | 'live'

export type EnvironmentConfig = {
	name: EnvironmentName
	/**
	 * AWS account id and region. Read from the environment so no account numbers live in git.
	 * When unset the stacks are environment-agnostic, which keeps `cdk synth` free of AWS lookups.
	 */
	account?: string
	region?: string
	/** Public origin of the SPA, passed to the API for CORS */
	appUrl: string
	auth: { jwksUrl: string; issuer: string; audience: string }
}

type Config = {
	serviceName: string
	environments: EnvironmentConfig[]
}

const account = process.env.CDK_DEFAULT_ACCOUNT
const region = process.env.CDK_DEFAULT_REGION

export const config: Config = {
	serviceName: 'web',
	environments: [
		{
			name: 'dev',
			account,
			region,
			appUrl: 'https://dev.example.com',
			auth: {
				jwksUrl: 'https://auth.example.com/.well-known/jwks.json',
				issuer: 'https://auth.example.com',
				audience: 'template-web',
			},
		},
		{
			name: 'live',
			account,
			region,
			appUrl: 'https://example.com',
			auth: {
				jwksUrl: 'https://auth.example.com/.well-known/jwks.json',
				issuer: 'https://auth.example.com',
				audience: 'template-web',
			},
		},
	],
}
