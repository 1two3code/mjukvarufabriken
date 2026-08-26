import { Stack } from 'aws-cdk-lib'
import { CfnBudget } from 'aws-cdk-lib/aws-budgets'

import type { StackProps } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import type { EnvironmentConfig } from './config.ts'

type BudgetStackProps = StackProps & {
	environment: EnvironmentConfig
	/** The `mf-alerts-<env>` topic of the ops stack (its policy lets budgets.amazonaws.com publish) */
	alertsTopic: { region: string; name: string }
}

/**
 * Monthly cost budget for everything tagged Environment=<env>. `AWS::Budgets::Budget` only
 * exists in us-east-1 (Budgets is a global service fronted there), so it lives in its own
 * stack pinned to that region; it publishes to the ops stack's topic in eu-north-1 by ARN.
 * The `Environment` cost-allocation tag must be activated once under Billing (TODO-EXTERNAL);
 * until then the filtered spend reads 0.
 */
export class BudgetStack extends Stack {
	constructor(scope: Construct, id: string, { environment, alertsTopic, ...props }: BudgetStackProps) {
		super(scope, id, props)
		this.templateOptions.description = `Monthly cost budget (${environment.name})`

		// Same account, other region: the account id resolves at deploy time, the region is fixed
		const topicArn = `arn:${this.partition}:sns:${alertsTopic.region}:${this.account}:${alertsTopic.name}`
		const subscribers = [{ subscriptionType: 'SNS', address: topicArn }]
		new CfnBudget(this, 'MonthlyBudget', {
			budget: {
				budgetName: `mf-${environment.name}-monthly`,
				budgetType: 'COST',
				timeUnit: 'MONTHLY',
				budgetLimit: { amount: environment.alerts.monthlyBudgetUsd, unit: 'USD' },
				costFilters: { TagKeyValue: [`user:Environment$${environment.name}`] },
			},
			notificationsWithSubscribers: [
				{
					notification: {
						notificationType: 'ACTUAL',
						comparisonOperator: 'GREATER_THAN',
						threshold: 80,
						thresholdType: 'PERCENTAGE',
					},
					subscribers,
				},
				{
					notification: {
						notificationType: 'FORECASTED',
						comparisonOperator: 'GREATER_THAN',
						threshold: 100,
						thresholdType: 'PERCENTAGE',
					},
					subscribers,
				},
			],
		})
	}
}
