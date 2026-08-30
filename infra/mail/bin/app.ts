import { App } from 'aws-cdk-lib'

import { loadConfig } from '../lib/config.ts'
import { MailStack } from '../lib/mail-stack.ts'

const app = new App()
const config = loadConfig(app)

new MailStack(app, 'mf-mail', {
	env: config.account ? { account: config.account, region: config.region } : undefined,
	config,
})
