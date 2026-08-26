import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { App } from 'aws-cdk-lib'

import { loadConfig } from '../lib/config.ts'
import { ResidentStack } from '../lib/resident-stack.ts'

const app = new App()
const config = loadConfig(app)
const repositoryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')

new ResidentStack(app, `mf-resident-${config.installationId}`.slice(0, 128), {
	env: config.account ? { account: config.account, region: config.region } : undefined,
	config,
	repositoryRoot,
})
