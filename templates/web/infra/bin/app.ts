import { App, Tags } from 'aws-cdk-lib'

import { config } from '../lib/config.ts'
import { createRelativePath } from '../lib/helpers.ts'
import { ResourcesStack } from '../lib/resources-stack.ts'
import { WebStack } from '../lib/web-stack.ts'

const app = new App()

for (const environment of config.environments) {
	const env = environment.account
		? { account: environment.account, region: environment.region }
		: undefined

	// Resources first — the web stack references its VPC, table and bucket
	const resources = new ResourcesStack(app, `resources-${environment.name}`, { env, environment })

	const web = new WebStack(app, `${config.serviceName}-${environment.name}`, {
		env,
		environment,
		resources,
		appDistPath: createRelativePath(import.meta.url, `../../apps/app/dist/${environment.name}`),
		repositoryRoot: createRelativePath(import.meta.url, '../..'),
	})

	for (const stack of [resources, web]) {
		Tags.of(stack).add('Service', config.serviceName)
		Tags.of(stack).add('Environment', environment.name)
	}
}
