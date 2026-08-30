import { Duration, Stack } from 'aws-cdk-lib'
import {
	Alarm,
	AnomalyDetectionAlarm,
	ComparisonOperator,
	MathExpression,
	Metric,
	Stats,
	TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch'
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions'
import { HttpCodeElb, HttpCodeTarget } from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import { Effect, PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam'
import { FilterPattern, MetricFilter } from 'aws-cdk-lib/aws-logs'
import { Topic } from 'aws-cdk-lib/aws-sns'
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions'

import type { StackProps } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import type { EnvironmentConfig } from './config.ts'
import type { ResourcesStack } from './resources-stack.ts'
import type { WebStack } from './web-stack.ts'

export interface OpsStackProps extends StackProps {
	environment: EnvironmentConfig
	resources: ResourcesStack
	web: WebStack
}

/**
 * Alerting (M9): one SNS topic `mf-alerts-<env>` that every alarm and the monthly budget
 * publish to, e-mailed to `adminEmails`. Deployed last — it only reads the other two stacks
 * (CDK creates the cross-stack exports). What each alarm means and what to check first is in
 * docs/RUNBOOK.md; the anchors in the alarm descriptions point there.
 */
export class OpsStack extends Stack {
	readonly topic: Topic

	constructor(scope: Construct, id: string, props: OpsStackProps) {
		super(scope, id, props)

		const { environment, resources, web } = props
		const { alerts } = environment
		const namespace = `mf/${environment.name}`
		const period = Duration.minutes(5)

		this.templateOptions.description = `Alerts and budgets (${environment.name})`

		// MARK: Topic — each e-mail subscription must be confirmed by its recipient (TODO-EXTERNAL)
		this.topic = new Topic(this, 'AlertsTopic', {
			topicName: `mf-alerts-${environment.name}`,
			displayName: `mf ${environment.name} alerts`,
		})
		for (const email of environment.adminEmails) {
			this.topic.addSubscription(new EmailSubscription(email))
		}
		// AWS Budgets publishes its notifications from the service principal, not from this
		// account. The source conditions keep a budget in someone else's account from using our
		// (predictably named) topic to mail the admins (confused deputy).
		this.topic.addToResourcePolicy(
			new PolicyStatement({
				sid: 'AllowBudgetsPublish',
				effect: Effect.ALLOW,
				principals: [new ServicePrincipal('budgets.amazonaws.com')],
				actions: ['sns:Publish'],
				resources: [this.topic.topicArn],
				conditions: {
					StringEquals: { 'aws:SourceAccount': this.account },
					ArnLike: { 'aws:SourceArn': `arn:${this.partition}:budgets::${this.account}:budget/*` },
				},
			})
		)

		const notify = new SnsAction(this.topic)
		const createAlarm = (alarm: Alarm) => {
			alarm.addAlarmAction(notify)
			alarm.addOkAction(notify)
			return alarm
		}

		// MARK: Build jobs — metric filters over the JSON log lines written by apps/job:
		// `{"message":"event failed",...}` (the orchestrator gave up), `{"message":"job crashed",...}`
		// (SIGTERM / unhandled rejection / thrown outside the orchestrator — that path bypasses
		// `emit`, so no `event failed` line) and `{"message":"job finished","tokensUsed":N,...}`.
		// Customer build scripts write to the same log stream, so these lines can be spoofed; the
		// real fix is api-side job reporting (PLAN.md, M3 hardening).
		const failedJobs = new MetricFilter(this, 'FailedJobsFilter', {
			logGroup: resources.jobLogGroup,
			filterPattern: FilterPattern.any(
				FilterPattern.stringValue('$.message', '=', 'event failed'),
				FilterPattern.stringValue('$.message', '=', 'job crashed')
			),
			metricNamespace: namespace,
			metricName: 'JobsFailed',
			metricValue: '1',
		})
		createAlarm(
			new Alarm(this, 'FailedJobsAlarm', {
				alarmName: `mf-${environment.name}-jobs-failed`,
				alarmDescription:
					'A build job logged "event failed" or "job crashed" (docs/RUNBOOK.md#jobs-failed)',
				metric: failedJobs.metric({ statistic: Stats.SUM, period }),
				threshold: 1,
				evaluationPeriods: 1,
				comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
				treatMissingData: TreatMissingData.NOT_BREACHING,
			})
		)

		const jobTokens = new MetricFilter(this, 'JobTokensFilter', {
			logGroup: resources.jobLogGroup,
			filterPattern: FilterPattern.stringValue('$.message', '=', 'job finished'),
			metricNamespace: namespace,
			metricName: 'JobTokensUsed',
			metricValue: '$.tokensUsed',
		})
		createAlarm(
			new Alarm(this, 'JobTokenBurnAlarm', {
				alarmName: `mf-${environment.name}-job-token-burn`,
				alarmDescription: `A single job used more than ${alerts.jobTokensThreshold.toLocaleString('en-US')} tokens (docs/RUNBOOK.md#job-token-burn)`,
				metric: jobTokens.metric({ statistic: Stats.MAXIMUM, period }),
				threshold: alerts.jobTokensThreshold,
				evaluationPeriods: 1,
				comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
				treatMissingData: TreatMissingData.NOT_BREACHING,
			})
		)

		// MARK: Api — ALB metrics. 5xx from the targets (the api threw/crashed) and from the ALB
		// itself (no healthy target, timeouts) are summed; unhealthy hosts is the earlier signal.
		const { loadBalancer, targetGroup } = web.api
		createAlarm(
			new Alarm(this, 'Api5xxAlarm', {
				alarmName: `mf-${environment.name}-api-5xx`,
				alarmDescription: '5 or more HTTP 5xx from the api in 5 minutes (docs/RUNBOOK.md#api-5xx)',
				metric: new MathExpression({
					expression: 'FILL(target, 0) + FILL(alb, 0)',
					usingMetrics: {
						target: targetGroup.metrics.httpCodeTarget(HttpCodeTarget.TARGET_5XX_COUNT, {
							statistic: Stats.SUM,
							period,
						}),
						alb: loadBalancer.metrics.httpCodeElb(HttpCodeElb.ELB_5XX_COUNT, {
							statistic: Stats.SUM,
							period,
						}),
					},
					label: 'api 5xx',
					period,
				}),
				threshold: 5,
				evaluationPeriods: 1,
				comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
				treatMissingData: TreatMissingData.NOT_BREACHING,
			})
		)
		createAlarm(
			new Alarm(this, 'ApiUnhealthyAlarm', {
				alarmName: `mf-${environment.name}-api-unhealthy`,
				alarmDescription: 'An api task fails the /health check (docs/RUNBOOK.md#api-unhealthy)',
				metric: targetGroup.metrics.unhealthyHostCount({ statistic: Stats.MAXIMUM, period }),
				threshold: 1,
				evaluationPeriods: 2,
				comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
				treatMissingData: TreatMissingData.NOT_BREACHING,
			})
		)

		// MARK: RDS
		const { database } = resources
		createAlarm(
			new Alarm(this, 'RdsCpuAlarm', {
				alarmName: `mf-${environment.name}-rds-cpu`,
				alarmDescription: 'Postgres CPU above 80 % for 15 minutes (docs/RUNBOOK.md#rds-cpu)',
				metric: database.metricCPUUtilization({ statistic: Stats.AVERAGE, period }),
				threshold: 80,
				evaluationPeriods: 3,
				comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
			})
		)
		createAlarm(
			new Alarm(this, 'RdsStorageAlarm', {
				alarmName: `mf-${environment.name}-rds-storage`,
				alarmDescription: 'Postgres free storage below 2 GB (docs/RUNBOOK.md#rds-storage)',
				metric: database.metricFreeStorageSpace({ statistic: Stats.MINIMUM, period }),
				threshold: 2 * 1024 ** 3,
				evaluationPeriods: 1,
				comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
			})
		)
		createAlarm(
			new Alarm(this, 'RdsMemoryAlarm', {
				alarmName: `mf-${environment.name}-rds-memory`,
				alarmDescription:
					'Postgres freeable memory below 128 MB for 15 minutes (docs/RUNBOOK.md#rds-memory)',
				metric: database.metricFreeableMemory({ statistic: Stats.MINIMUM, period }),
				threshold: 128 * 1024 ** 2,
				evaluationPeriods: 3,
				comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
			})
		)

		// MARK: NAT gateway egress (cost). Two alarms on the same metric: a plain hourly threshold
		// from config (fires on the first big spike, no learning period) and an anomaly band that
		// catches a slow drift once CloudWatch has two weeks of history.
		const natBytesOut = new Metric({
			namespace: 'AWS/NATGateway',
			metricName: 'BytesOutToDestination',
			dimensionsMap: { NatGatewayId: resources.natGatewayId },
			statistic: Stats.SUM,
			period: Duration.hours(1),
		})
		const natThresholdGb = Math.round(alerts.natBytesOutPerHourThreshold / 1024 ** 3)
		createAlarm(
			new Alarm(this, 'NatEgressAlarm', {
				alarmName: `mf-${environment.name}-nat-egress`,
				alarmDescription: `NAT gateway sent more than ${natThresholdGb} GB in an hour (docs/RUNBOOK.md#nat-egress)`,
				metric: natBytesOut,
				threshold: alerts.natBytesOutPerHourThreshold,
				evaluationPeriods: 1,
				comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
				treatMissingData: TreatMissingData.NOT_BREACHING,
			})
		)
		createAlarm(
			new AnomalyDetectionAlarm(this, 'NatEgressAnomalyAlarm', {
				alarmName: `mf-${environment.name}-nat-egress-anomaly`,
				alarmDescription:
					'NAT gateway egress far above its usual hourly pattern (docs/RUNBOOK.md#nat-egress)',
				metric: natBytesOut,
				stdDevs: 3,
				evaluationPeriods: 2,
				comparisonOperator: ComparisonOperator.GREATER_THAN_UPPER_THRESHOLD,
				treatMissingData: TreatMissingData.NOT_BREACHING,
			})
		)

		// The monthly cost budget lives in `budget-<env>` (us-east-1, see budget-stack.ts) and
		// publishes to this topic; the policy above is what lets budgets.amazonaws.com do that.
	}
}
