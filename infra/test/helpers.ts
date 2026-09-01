import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'

import { config } from '../lib/config.ts'
import { createRelativePath } from '../lib/helpers.ts'
import { BudgetStack } from '../lib/budget-stack.ts'
import { OpsStack } from '../lib/ops-stack.ts'
import { ResourcesStack } from '../lib/resources-stack.ts'
import { WebStack } from '../lib/web-stack.ts'

import type { EnvironmentName } from '../lib/config.ts'

/** A throw-away directory standing in for a built SPA (BucketDeployment needs the path to exist) */
export const createFakeDist = () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'mf-dist-'))
	writeFileSync(path.join(dir, 'index.html'), '<html></html>')
	return dir
}

/**
 * Synthesises the three stacks of one environment the same way bin/app.ts does.
 *
 * `context` seeds the App's context — used to pin behaviour that would otherwise depend on a CDK
 * feature flag (see infra/test/deploy-guard.test.ts).
 */
export const synthEnvironment = (name: EnvironmentName, context?: Record<string, unknown>) => {
	const environment = config.environments.find(e => e.name === name)!
	const app = new App({ context })
	const repositoryRoot = createRelativePath(import.meta.url, '../..')
	const resources = new ResourcesStack(app, `resources-${name}`, { environment, repositoryRoot })
	const web = new WebStack(app, `mf-${name}`, {
		environment,
		resources,
		siteDistPath: createFakeDist(),
		portalDistPath: createFakeDist(),
		repositoryRoot,
	})
	const ops = new OpsStack(app, `ops-${name}`, { environment, resources, web })
	const budget = new BudgetStack(app, `budget-${name}`, {
		env: { region: 'us-east-1' },
		environment,
		alertsTopic: { region: 'eu-north-1', name: `mf-alerts-${name}` },
	})
	return {
		environment,
		resources: Template.fromStack(resources),
		web: Template.fromStack(web),
		ops: Template.fromStack(ops),
		budget: Template.fromStack(budget),
	}
}
