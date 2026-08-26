import { App, Tags } from 'aws-cdk-lib'

import { config } from '../lib/config.ts'
import { createRelativePath } from '../lib/helpers.ts'
import { WebStack } from '../lib/web-stack.ts'

const app = new App()

for (const environment of config.environments) {
	const stack = new WebStack(app, `${config.serviceName}-${environment.name}`, {
		env: environment.account
			? { account: environment.account, region: environment.region }
			: undefined,
		environment,
		appDistPath: createRelativePath(import.meta.url, `../../apps/app/dist/${environment.name}`),
		repositoryRoot: createRelativePath(import.meta.url, '../..'),
	})

	Tags.of(stack).add('Service', config.serviceName)
	Tags.of(stack).add('Environment', environment.name)
}
