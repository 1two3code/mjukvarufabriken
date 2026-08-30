import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Match } from 'aws-cdk-lib/assertions'

import { synthEnvironment } from './helpers.ts'

describe('OpsStack', () => {
	const { ops, budget, environment } = synthEnvironment('dev')

	it('creates the alerts topic with an e-mail subscription per admin', () => {
		ops.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'mf-alerts-dev' })
		ops.resourceCountIs('AWS::SNS::Subscription', environment.adminEmails.length)
		ops.hasResourceProperties('AWS::SNS::Subscription', {
			Protocol: 'email',
			Endpoint: environment.adminEmails[0],
		})
		// AWS Budgets must be allowed to publish — but only budgets in this account (confused deputy)
		ops.hasResourceProperties('AWS::SNS::TopicPolicy', {
			PolicyDocument: {
				Statement: Match.arrayWith([
					Match.objectLike({
						Action: 'sns:Publish',
						Principal: { Service: 'budgets.amazonaws.com' },
						Condition: {
							StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } },
							ArnLike: {
								'aws:SourceArn': {
									'Fn::Join': [
										'',
										Match.arrayWith([
											Match.stringLikeRegexp('^arn:'),
											{ Ref: 'AWS::Partition' },
											Match.stringLikeRegexp('^:budgets::$'),
											{ Ref: 'AWS::AccountId' },
											':budget/*',
										]),
									],
								},
							},
						},
					}),
				]),
			},
		})
		// No unconditional publish grant for the service principal
		for (const policy of Object.values(ops.findResources('AWS::SNS::TopicPolicy'))) {
			const { Statement } = (policy.Properties as { PolicyDocument: { Statement: unknown[] } })
				.PolicyDocument
			for (const statement of Statement as { Principal?: unknown; Condition?: unknown }[]) {
				if (JSON.stringify(statement.Principal).includes('budgets.amazonaws.com')) {
					assert.ok(statement.Condition, 'budgets publish statement must carry a source condition')
				}
			}
		}
	})

	it('keeps the budget out of this stack (Budgets only exist in us-east-1) but lets it publish', () => {
		ops.resourceCountIs('AWS::Budgets::Budget', 0)
		ops.resourceCountIs('AWS::SNS::TopicPolicy', 1)
	})

	it('derives failed-job and token-burn metrics from the api’s own mf/dev custom metrics, not job log lines (M3 hardening #2)', () => {
		// No more log-line pattern matching — a customer's own build script output shares that
		// log stream and could otherwise spoof/hide either alarm.
		assert.equal(
			Object.keys(ops.findResources('AWS::Logs::MetricFilter')).length,
			0,
			'no MetricFilter should read the job log group any more'
		)
		ops.hasResourceProperties('AWS::CloudWatch::Alarm', {
			AlarmName: 'mf-dev-jobs-failed',
			Namespace: 'mf/dev',
			MetricName: 'JobsFailed',
			Statistic: 'Sum',
			Period: 300,
			Threshold: 1,
			ComparisonOperator: 'GreaterThanOrEqualToThreshold',
		})
		ops.hasResourceProperties('AWS::CloudWatch::Alarm', {
			AlarmName: 'mf-dev-job-token-burn',
			Namespace: 'mf/dev',
			MetricName: 'JobTokensUsed',
			Statistic: 'Maximum',
			Threshold: environment.alerts.jobTokensThreshold,
		})
	})

	it('alarms on api 5xx, unhealthy targets, RDS and NAT egress', () => {
		const names = Object.values(ops.findResources('AWS::CloudWatch::Alarm')).map(
			r => (r.Properties as { AlarmName: string }).AlarmName
		)
		assert.deepEqual(names.sort(), [
			'mf-dev-api-5xx',
			'mf-dev-api-unhealthy',
			'mf-dev-job-token-burn',
			'mf-dev-jobs-failed',
			'mf-dev-nat-egress',
			'mf-dev-nat-egress-anomaly',
			'mf-dev-rds-cpu',
			'mf-dev-rds-memory',
			'mf-dev-rds-storage',
		])
		ops.hasResourceProperties('AWS::CloudWatch::Alarm', {
			AlarmName: 'mf-dev-api-5xx',
			Threshold: 5,
			Metrics: Match.arrayWith([
				Match.objectLike({ Expression: 'FILL(target, 0) + FILL(alb, 0)' }),
			]),
		})
		ops.hasResourceProperties('AWS::CloudWatch::Alarm', {
			AlarmName: 'mf-dev-rds-cpu',
			Threshold: 80,
			EvaluationPeriods: 3,
		})
		ops.hasResourceProperties('AWS::CloudWatch::Alarm', {
			AlarmName: 'mf-dev-rds-storage',
			Threshold: 2 * 1024 ** 3,
			ComparisonOperator: 'LessThanThreshold',
		})
		ops.hasResourceProperties('AWS::CloudWatch::Alarm', {
			AlarmName: 'mf-dev-nat-egress',
			Namespace: 'AWS/NATGateway',
			MetricName: 'BytesOutToDestination',
			Period: 3600,
			Threshold: environment.alerts.natBytesOutPerHourThreshold,
		})
		ops.hasResourceProperties('AWS::CloudWatch::Alarm', {
			AlarmName: 'mf-dev-nat-egress-anomaly',
			ComparisonOperator: 'GreaterThanUpperThreshold',
			ThresholdMetricId: Match.anyValue(),
		})
	})

	it('routes every alarm to the topic', () => {
		for (const alarm of Object.values(ops.findResources('AWS::CloudWatch::Alarm'))) {
			const { AlarmActions, OKActions } = alarm.Properties as {
				AlarmActions: unknown[]
				OKActions: unknown[]
			}
			assert.equal(AlarmActions.length, 1)
			assert.equal(OKActions.length, 1)
		}
	})

	it('creates a monthly budget (us-east-1 stack) with 80 % actual and 100 % forecasted notifications to the alerts topic', () => {
		budget.hasResourceProperties('AWS::Budgets::Budget', {
			Budget: {
				BudgetName: 'mf-dev-monthly',
				BudgetType: 'COST',
				TimeUnit: 'MONTHLY',
				BudgetLimit: { Amount: environment.alerts.monthlyBudgetUsd, Unit: 'USD' },
				CostFilters: { TagKeyValue: ['user:Environment$dev'] },
			},
			NotificationsWithSubscribers: [
				Match.objectLike({
					Notification: Match.objectLike({ NotificationType: 'ACTUAL', Threshold: 80 }),
					Subscribers: [
						Match.objectLike({
							SubscriptionType: 'SNS',
							Address: { 'Fn::Join': ['', Match.arrayWith([':sns:eu-north-1:', ':mf-alerts-dev'])] },
						}),
					],
				}),
				Match.objectLike({
					Notification: Match.objectLike({ NotificationType: 'FORECASTED', Threshold: 100 }),
				}),
			],
		})
	})
})
