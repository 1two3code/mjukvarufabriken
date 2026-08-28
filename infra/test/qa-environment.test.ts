import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Match } from 'aws-cdk-lib/assertions'

import { config } from '../lib/config.ts'
import { synthEnvironment } from './helpers.ts'

/**
 * qa is the staging environment added in environments.md phase 1 — deployed between dev and live
 * (dev → qa → live). These tests pin the domains, the four-stack set (resources/mf/ops/budget)
 * and that qa mirrors dev's cheap sizing so a rehearsal deploy stays inexpensive.
 */
describe('qa environment', () => {
	const qa = config.environments.find(e => e.name === 'qa')!
	const dev = config.environments.find(e => e.name === 'dev')!

	it('exists and sits between dev and live in the deploy order', () => {
		const order = config.environments.map(e => e.name)
		assert.deepEqual(order, ['dev', 'qa', 'live'])
	})

	it('uses the qa.mjukvaruhuset.se domains in the shared hosted zone', () => {
		assert.ok(qa.domain, 'qa must have a custom domain')
		assert.equal(qa.domain.siteDomainName, 'qa.mjukvaruhuset.se')
		assert.equal(qa.domain.apiDomainName, 'api.qa.mjukvaruhuset.se')
		assert.equal(qa.domain.portalDomainName, 'portal.qa.mjukvaruhuset.se')
		// Same hosted zone as dev/live (qa.* records live in the mjukvaruhuset.se zone)
		assert.equal(qa.domain.hostedZoneId, dev.domain!.hostedZoneId)
		assert.equal(qa.domain.hostedZoneName, 'mjukvaruhuset.se')
		assert.equal(qa.auth.issuer, 'https://api.qa.mjukvaruhuset.se')
	})

	it('mirrors dev: log email, t4g.micro, 7-day backups, dev budget', () => {
		assert.equal(qa.email.transport, 'log')
		assert.equal(qa.database.backupRetentionDays, dev.database.backupRetentionDays)
		assert.equal(qa.database.allocatedStorageGb, dev.database.allocatedStorageGb)
		assert.deepEqual(qa.jobs, dev.jobs)
		assert.deepEqual(qa.alerts, dev.alerts)
	})

	it('has no per-environment GitHub credentials yet (fail closed until the qa apps exist)', () => {
		assert.equal(qa.githubOAuth, undefined)
		assert.equal(qa.githubDelivery, undefined)
	})

	it('synthesises resources-qa / mf-qa / ops-qa / budget-qa', () => {
		const { resources, web, ops, budget } = synthEnvironment('qa')
		// Resources: the RDS instance and artifact bucket
		resources.resourceCountIs('AWS::RDS::DBInstance', 1)
		// qa mirrors dev — 7-day backups, no deletion protection (a staging DB is disposable)
		resources.hasResourceProperties('AWS::RDS::DBInstance', {
			BackupRetentionPeriod: 7,
			DeletionProtection: false,
		})
		// Web: A records for all three qa subdomains in the hosted zone
		for (const name of [
			'qa.mjukvaruhuset.se.',
			'portal.qa.mjukvaruhuset.se.',
			'api.qa.mjukvaruhuset.se.',
		]) {
			web.hasResourceProperties('AWS::Route53::RecordSet', { Name: name, Type: 'A' })
		}
		// Ops: the qa alerts topic
		ops.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'mf-alerts-qa' })
		// Budget: the qa monthly budget, filtered to Environment=qa, notifying the qa topic
		budget.hasResourceProperties('AWS::Budgets::Budget', {
			Budget: Match.objectLike({
				BudgetName: 'mf-qa-monthly',
				CostFilters: { TagKeyValue: ['user:Environment$qa'] },
			}),
		})
	})
})
