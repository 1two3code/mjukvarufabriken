import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'

import { DEFAULT_FORWARD_TO, DEFAULT_FROM_ADDRESS, DEFAULT_HOSTED_ZONE_NAME, loadConfig } from '../lib/config.ts'
import { MailStack } from '../lib/mail-stack.ts'

const synth = (context: Record<string, string> = {}) => {
	const app = new App({ context })
	const config = loadConfig(app)
	const stack = new MailStack(app, 'mf-mail', { config })
	return { config, template: Template.fromStack(stack) }
}

describe('MailStack', () => {
	const { config, template } = synth()

	it('synthesises offline with checked-in defaults, no context or AWS calls needed', () => {
		assert.equal(config.hostedZoneName, DEFAULT_HOSTED_ZONE_NAME)
		assert.equal(config.forwardTo, DEFAULT_FORWARD_TO)
	})

	it('points the MX record at the SES inbound endpoint', () => {
		template.hasResourceProperties('AWS::Route53::RecordSet', {
			Type: 'MX',
			Name: `${DEFAULT_HOSTED_ZONE_NAME}.`,
			ResourceRecords: Match.arrayWith([
				Match.objectLike({
					'Fn::Join': Match.arrayWith([
						Match.arrayWith([Match.stringLikeRegexp('^10 inbound-smtp\\.')]),
					]),
				}),
			]),
		})
	})

	it('receives for the whole domain and writes raw mail to S3 before forwarding', () => {
		template.hasResourceProperties('AWS::SES::ReceiptRule', {
			Rule: Match.objectLike({
				Recipients: [DEFAULT_HOSTED_ZONE_NAME],
				Actions: Match.arrayWith([
					Match.objectLike({ S3Action: Match.objectLike({ ObjectKeyPrefix: 'inbound/' }) }),
					Match.objectLike({ LambdaAction: Match.objectLike({ InvocationType: 'Event' }) }),
				]),
			}),
		})
	})

	it('activates the receipt rule set via a custom resource (CDK has no native L1/L2 for it)', () => {
		template.resourceCountIs('Custom::AWS', 1)
		template.hasResourceProperties('AWS::IAM::Policy', {
			PolicyDocument: Match.objectLike({
				Statement: Match.arrayWith([Match.objectLike({ Action: 'ses:SetActiveReceiptRuleSet' })]),
			}),
		})
	})

	it('forwarder can send only as the configured from-address, to anyone', () => {
		template.hasResourceProperties('AWS::IAM::Policy', {
			PolicyDocument: Match.objectLike({
				Statement: Match.arrayWith([
					Match.objectLike({
						Action: ['ses:SendEmail', 'ses:SendRawEmail'],
						Resource: '*',
						Condition: { StringEquals: { 'ses:FromAddress': DEFAULT_FROM_ADDRESS } },
					}),
				]),
			}),
		})
	})

	it('honours a different forward address from context', () => {
		const custom = synth({ forwardTo: 'someone-else@example.com' })
		assert.equal(custom.config.forwardTo, 'someone-else@example.com')
		custom.template.hasResourceProperties('AWS::Lambda::Function', {
			Environment: { Variables: Match.objectLike({ FORWARD_TO: 'someone-else@example.com' }) },
		})
	})
})
