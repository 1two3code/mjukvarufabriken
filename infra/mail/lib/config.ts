import type { App } from 'aws-cdk-lib'

export type MailConfig = {
	/** The one Route 53 hosted zone shared by every env (dev/qa/live all read the same zone) */
	hostedZoneId: string
	hostedZoneName: string
	/** Verified SES domain identity the forwarder re-sends from — must be `@hostedZoneName` */
	fromAddress: string
	/** Where every inbound message goes, for now (catch-all, no per-recipient routing yet) */
	forwardTo: string
	account?: string
	region?: string
}

/** Route 53 zone for mjukvaruhuset.se (see infra/lib/config.ts — shared by dev/qa/live). */
export const DEFAULT_HOSTED_ZONE_ID = 'Z002863610X79ZE1B3K8F'
export const DEFAULT_HOSTED_ZONE_NAME = 'mjukvaruhuset.se'
/** Same verified sending identity the api already uses (apps/api/src/plugins/email.ts). */
export const DEFAULT_FROM_ADDRESS = 'noreply@mjukvaruhuset.se'
/** Same address already checked in as adminEmails in every env (infra/lib/config.ts). */
export const DEFAULT_FORWARD_TO = 'hasse.lofgren@outlook.com'

const contextString = (app: App, key: string) => {
	const value = app.node.tryGetContext(key) as unknown
	return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Everything comes from CDK context (`-c forwardTo=...`) or a safe, checked-in default, so a
 * plain `cdk synth` stays offline and green — no AWS lookups at synth time.
 */
export const loadConfig = (app: App): MailConfig => {
	const account = process.env.CDK_DEFAULT_ACCOUNT
	return {
		hostedZoneId: contextString(app, 'hostedZoneId') || DEFAULT_HOSTED_ZONE_ID,
		hostedZoneName: contextString(app, 'hostedZoneName') || DEFAULT_HOSTED_ZONE_NAME,
		fromAddress: contextString(app, 'fromAddress') || DEFAULT_FROM_ADDRESS,
		forwardTo: contextString(app, 'forwardTo') || DEFAULT_FORWARD_TO,
		account,
		region: account ? 'eu-north-1' : undefined,
	}
}
