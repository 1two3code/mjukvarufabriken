import { App, Tags } from 'aws-cdk-lib'

import { config } from '../lib/config.ts'
import { createRelativePath } from '../lib/helpers.ts'
import { BudgetStack } from '../lib/budget-stack.ts'
import { OpsStack } from '../lib/ops-stack.ts'
import { ResourcesStack } from '../lib/resources-stack.ts'
import { WebStack } from '../lib/web-stack.ts'

const app = new App()

for (const environment of config.environments) {
	const env = environment.account
		? { account: environment.account, region: environment.region }
		: undefined

	// Resources first — the web stack references its VPC, table and bucket
	const repositoryRoot = createRelativePath(import.meta.url, '../..')
	const resources = new ResourcesStack(app, `resources-${environment.name}`, {
		env,
		environment,
		repositoryRoot,
	})

	const web = new WebStack(app, `${config.serviceName}-${environment.name}`, {
		env,
		environment,
		resources,
		siteDistPath: createRelativePath(import.meta.url, `../../apps/site/dist/${environment.name}`),
		portalDistPath: createRelativePath(
			import.meta.url,
			`../../apps/portal/dist/${environment.name}`
		),
		repositoryRoot,
	})

	// Alarms + budget last: reads the log groups, ALB, RDS and NAT gateway of the two above
	const ops = new OpsStack(app, `ops-${environment.name}`, { env, environment, resources, web })

	// Budgets only exist in us-east-1; the topic ARN is passed as a plain string (no cross-region export)
	const budget = new BudgetStack(app, `budget-${environment.name}`, {
		env: { ...env, region: 'us-east-1' },
		environment,
		alertsTopicArn: `arn:aws:sns:${environment.region}:${environment.account ?? process.env.CDK_DEFAULT_ACCOUNT}:mf-alerts-${environment.name}`,
	})
	budget.addDependency(ops)

	for (const stack of [resources, web, ops, budget]) {
		Tags.of(stack).add('Service', config.serviceName)
		Tags.of(stack).add('Environment', environment.name)
	}
}
