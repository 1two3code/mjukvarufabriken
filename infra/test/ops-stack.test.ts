import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Match } from 'aws-cdk-lib/assertions'

import { synthEnvironment } from './helpers.ts'

describe('OpsStack', () => {
	const { ops, environment } = synthEnvironment('dev')

	it('creates the alerts topic with an e-mail subscription per admin', () => {
		ops.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'mf-alerts-dev' })
		ops.resourceCountIs('AWS::SNS::Subscription', environment.adminEmails.length)
		ops.hasResourceProperties('AWS::SNS::Subscription', {
			Protocol: 'email',
			Endpoint: environment.adminEmails[0],
		})
		// AWS Budgets must be allowed to publish
		ops.hasResourceProperties('AWS::SNS::TopicPolicy', {
			PolicyDocument: {
				Statement: Match.arrayWith([
					Match.objectLike({
						Action: 'sns:Publish',
						Principal: { Service: 'budgets.amazonaws.com' },
					}),
				]),
			},
		})
	})

	it('derives failed-job and token-burn metrics from the job log lines', () => {
		ops.hasResourceProperties('AWS::Logs::MetricFilter', {
			FilterPattern: '{ $.message = "event failed" }',
			MetricTransformations: [
				Match.objectLike({ MetricName: 'JobsFailed', MetricNamespace: 'mf/dev', MetricValue: '1' }),
			],
		})
		ops.hasResourceProperties('AWS::Logs::MetricFilter', {
			FilterPattern: '{ $.message = "job finished" }',
			MetricTransformations: [
				Match.objectLike({ MetricName: 'JobTokensUsed', MetricValue: '$.tokensUsed' }),
			],
		})
		ops.hasResourceProperties('AWS::CloudWatch::Alarm', {
			AlarmName: 'mf-dev-jobs-failed',
			MetricName: 'JobsFailed',
			Statistic: 'Sum',
			Period: 300,
			Threshold: 1,
			ComparisonOperator: 'GreaterThanOrEqualToThreshold',
		})
		ops.hasResourceProperties('AWS::CloudWatch::Alarm', {
			AlarmName: 'mf-dev-job-token-burn',
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

	it('creates a monthly budget with 80 % actual and 100 % forecasted notifications', () => {
		ops.hasResourceProperties('AWS::Budgets::Budget', {
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
					Subscribers: [Match.objectLike({ SubscriptionType: 'SNS' })],
				}),
				Match.objectLike({
					Notification: Match.objectLike({ NotificationType: 'FORECASTED', Threshold: 100 }),
				}),
			],
		})
	})
})
