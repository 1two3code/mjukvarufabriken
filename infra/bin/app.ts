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

	for (const stack of [resources, web]) {
		Tags.of(stack).add('Service', config.serviceName)
		Tags.of(stack).add('Environment', environment.name)
	}
}
