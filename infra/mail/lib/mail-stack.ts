import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib'
import { PolicyStatement } from 'aws-cdk-lib/aws-iam'
import { Code, Function as LambdaFunction, Runtime } from 'aws-cdk-lib/aws-lambda'
import { HostedZone, MxRecord } from 'aws-cdk-lib/aws-route53'
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3'
import { ReceiptRuleSet } from 'aws-cdk-lib/aws-ses'
import { Lambda as LambdaAction, LambdaInvocationType, S3 as S3Action } from 'aws-cdk-lib/aws-ses-actions'
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources'

import { createRelativePath } from './helpers.ts'

import type { StackProps } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import type { MailConfig } from './config.ts'

export type MailStackProps = StackProps & { config: MailConfig }

/**
 * Deployed ONCE into the management account, alongside infra/org — mjukvaruhuset.se has a single
 * Route 53 hosted zone shared by every env (dev/qa/live, see infra/lib/config.ts), so the inbound
 * MX and SES receipt rule set live outside the per-env resources-<env> loop (infra/bin/app.ts) to
 * avoid three stacks fighting over the same zone record.
 *
 * The domain can currently only send (SES). This makes it receive too: every address at
 * `config.hostedZoneName` — including the `aws+<slug>@mjukvaruhuset.se` root emails every vended
 * customer account needs (docs/backlog/org-accounts.md) and `hej@mjukvaruhuset.se` — forwards to
 * `config.forwardTo`. Catch-all on purpose: splitting recipients into their own rules/destinations
 * is a later step once there's an actual reason to (e.g. hej@ routing to a shared inbox instead of
 * one person).
 *
 * Flow: MX → SES receives → raw message written to `inboundBucket` (S3 is the only way to get the
 * full raw MIME body into the Lambda; a direct Lambda receipt action only gets headers/verdicts) →
 * `forwarder` reads it back out and re-sends it via `SendEmail` from a verified identity on this
 * domain, with the original sender preserved in `Reply-To`.
 */
export class MailStack extends Stack {
	readonly inboundBucket: Bucket
	readonly forwarder: LambdaFunction

	constructor(scope: Construct, id: string, { config, ...props }: MailStackProps) {
		super(scope, id, props)

		const hostedZone = HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
			hostedZoneId: config.hostedZoneId,
			zoneName: config.hostedZoneName,
		})

		// Transit storage only (the forwarder reads and re-sends within seconds) — not an archive,
		// so a short expiry is enough of a safety net if a message is ever left unprocessed.
		this.inboundBucket = new Bucket(this, 'InboundBucket', {
			encryption: BucketEncryption.S3_MANAGED,
			blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
			removalPolicy: RemovalPolicy.RETAIN,
			lifecycleRules: [{ expiration: Duration.days(30) }],
		})

		this.forwarder = new LambdaFunction(this, 'ForwardFunction', {
			functionName: 'mf-mail-forward',
			runtime: Runtime.NODEJS_24_X,
			handler: 'index.handler',
			code: Code.fromAsset(createRelativePath(import.meta.url, '../lambda')),
			timeout: Duration.seconds(30),
			environment: {
				BUCKET_NAME: this.inboundBucket.bucketName,
				FORWARD_TO: config.forwardTo,
				FROM_ADDRESS: config.fromAddress,
			},
		})
		this.inboundBucket.grantRead(this.forwarder)
		// Not a `grant*` helper: SES enforces a resource-level check against the RECIPIENT's
		// identity ARN too, whenever that recipient happens to also be a verified identity in this
		// account (as `forwardTo` now is, to satisfy the sandbox's "recipient must be verified"
		// rule) — a resource ARN scoped to just the sender identity 403s in production
		// ("not authorized to perform 'ses:SendRawEmail' on resource '.../identity/<forwardTo>'").
		// `Resource: '*'` with a `ses:FromAddress` condition is the actual, documented way to scope
		// a "send raw mail as this one address, to anyone" grant.
		this.forwarder.addToRolePolicy(
			new PolicyStatement({
				actions: ['ses:SendEmail', 'ses:SendRawEmail'],
				resources: ['*'],
				conditions: { StringEquals: { 'ses:FromAddress': config.fromAddress } },
			})
		)

		const ruleSet = new ReceiptRuleSet(this, 'RuleSet', { receiptRuleSetName: 'mf-mail-inbound' })
		ruleSet.addRule('Forward', {
			recipients: [config.hostedZoneName],
			scanEnabled: true,
			actions: [
				new S3Action({ bucket: this.inboundBucket, objectKeyPrefix: 'inbound/' }),
				new LambdaAction({ function: this.forwarder, invocationType: LambdaInvocationType.EVENT }),
			],
		})

		// CDK has no native "make this the account's active rule set" resource, and SES only ever
		// delivers through whichever one is active (there can only be one) — a custom resource
		// closes that gap instead of leaving it as a manual post-deploy step.
		new AwsCustomResource(this, 'ActivateRuleSet', {
			onCreate: {
				service: 'SES',
				action: 'setActiveReceiptRuleSet',
				parameters: { RuleSetName: ruleSet.receiptRuleSetName },
				physicalResourceId: PhysicalResourceId.of('mf-mail-active-rule-set'),
			},
			onUpdate: {
				service: 'SES',
				action: 'setActiveReceiptRuleSet',
				parameters: { RuleSetName: ruleSet.receiptRuleSetName },
				physicalResourceId: PhysicalResourceId.of('mf-mail-active-rule-set'),
			},
			policy: AwsCustomResourcePolicy.fromSdkCalls({ resources: AwsCustomResourcePolicy.ANY_RESOURCE }),
			// setActiveReceiptRuleSet is a long-stable SES API — no need to pull the latest AWS SDK
			// at deploy time (the default), which just adds a download this custom resource doesn't need.
			installLatestAwsSdk: false,
		})

		new MxRecord(this, 'InboundMx', {
			zone: hostedZone,
			values: [{ priority: 10, hostName: `inbound-smtp.${this.region}.amazonaws.com` }],
			ttl: Duration.minutes(5),
		})

		new CfnOutput(this, 'InboundBucketName', { value: this.inboundBucket.bucketName })
		new CfnOutput(this, 'ForwardTo', { value: config.forwardTo })
	}
}
