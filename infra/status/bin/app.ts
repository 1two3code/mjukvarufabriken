import { App } from 'aws-cdk-lib'

import { loadConfig } from '../lib/config.ts'
import { StatusStack } from '../lib/status-stack.ts'

const app = new App()
const config = loadConfig(app)

new StatusStack(app, 'mf-status', {
	env: config.account ? { account: config.account, region: config.region } : undefined,
	config,
})
