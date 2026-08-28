import { App } from 'aws-cdk-lib'

import { loadConfig } from '../lib/config.ts'
import { OrgStack } from '../lib/org-stack.ts'

const app = new App()
const config = loadConfig(app)

new OrgStack(app, 'mf-org', {
	env: config.account ? { account: config.account, region: config.region } : undefined,
	config,
})
