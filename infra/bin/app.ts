import { App, Tags } from 'aws-cdk-lib'

import { config } from '../lib/config.ts'
import { createRelativePath } from '../lib/helpers.ts'
import { BudgetStack } from '../lib/budget-stack.ts'
import { GithubDeployStack } from '../lib/github-deploy-stack.ts'
import { OpsStack } from '../lib/ops-stack.ts'
import { ResourcesStack } from '../lib/resources-stack.ts'
import { WebStack } from '../lib/web-stack.ts'

const app = new App()

// Once per ACCOUNT, not per environment: the GitHub OIDC provider + the role deploy.yml assumes.
// Deployed by hand the first time (`infra/scripts/deploy.sh dev github-deploy`) — it is what
// makes every later CI deploy possible. Region-agnostic apart from the bootstrap roles it may
// assume (eu-north-1 for the stacks, us-east-1 for the budget stack).
const firstEnvironment = config.environments[0]
const githubDeploy = new GithubDeployStack(app, 'github-deploy', {
	env: firstEnvironment?.account
		? { account: firstEnvironment.account, region: firstEnvironment.region }
		: undefined,
	repository: config.githubRepository,
	environments: config.environments.map(environment => environment.name),
	regions: [firstEnvironment?.region ?? process.env.CDK_DEFAULT_REGION ?? 'eu-north-1', 'us-east-1'],
})
Tags.of(githubDeploy).add('Service', config.serviceName)

// A deploy targets one env: `MF_ENV=<name>` builds only that env's stacks, so an un-namespaced
// `MF_*` value applies to it (lib/config.ts) and synth needs only that env's `dist/<env>` assets.
// Unset (CI's offline synth check) builds every env from the committed config, as before.
const onlyEnv = process.env.MF_ENV
for (const environment of config.environments) {
	if (onlyEnv && environment.name !== onlyEnv) continue
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
		alertsTopic: {
			region: environment.region ?? process.env.CDK_DEFAULT_REGION ?? 'eu-north-1',
			name: `mf-alerts-${environment.name}`,
		},
	})
	budget.addDependency(ops)

	for (const stack of [resources, web, ops, budget]) {
		Tags.of(stack).add('Service', config.serviceName)
		Tags.of(stack).add('Environment', environment.name)
	}
}
