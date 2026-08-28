import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildCustomersScp } from '../lib/customers-scp.ts'

describe('buildCustomersScp', () => {
	const doc = buildCustomersScp(['eu-north-1', 'us-east-1'])
	const byId = (sid: string) => {
		const statement = doc.Statement.find(s => s.Sid === sid)
		assert.ok(statement, `missing statement ${sid}`)
		return statement
	}

	it('is a well-formed policy where every statement denies', () => {
		assert.equal(doc.Version, '2012-10-17')
		assert.ok(doc.Statement.length >= 4)
		for (const statement of doc.Statement) assert.equal(statement.Effect, 'Deny')
	})

	it('region-locks to exactly the allowed regions and exempts global services', () => {
		const region = byId('RegionLock')
		assert.deepEqual(region.Condition?.StringNotEquals?.['aws:RequestedRegion'], [
			'eu-north-1',
			'us-east-1',
		])
		// Deny is expressed as NotAction (deny everything *except* the global services), never Action
		assert.equal(region.Action, undefined)
		const notAction = [region.NotAction].flat()
		// Only genuinely global/partition-wide services stay exempt — the lock would brick them
		for (const svc of ['budgets:*', 'iam:*', 'organizations:*', 'sts:*', 'cloudfront:*', 'route53:*'])
			assert.ok(notAction.includes(svc), `region lock must exempt ${svc}`)
		// Regional services are NOT exempt — they are what the lock is for. ACM and KMS are
		// regional: ACM-for-CloudFront lives in us-east-1, which is already an allowed region, so
		// neither needs a global exemption.
		assert.ok(!notAction.includes('ec2:*'))
		assert.ok(!notAction.includes('ecs:*'))
		assert.ok(!notAction.includes('acm:*'))
		assert.ok(!notAction.includes('kms:*'))
	})

	it('honours a custom region allow-list', () => {
		const euOnly = buildCustomersScp(['eu-north-1'])
		assert.deepEqual(euOnly.Statement.find(s => s.Sid === 'RegionLock')?.Condition?.StringNotEquals?.['aws:RequestedRegion'], ['eu-north-1'])
	})

	it('denies leaving the organization', () => {
		assert.equal(byId('DenyLeaveOrganization').Action, 'organizations:LeaveOrganization')
	})

	it('denies disabling or blinding CloudTrail', () => {
		const actions = [byId('DenyDisableCloudTrail').Action].flat()
		for (const action of [
			'cloudtrail:StopLogging',
			'cloudtrail:DeleteTrail',
			'cloudtrail:UpdateTrail',
			'cloudtrail:PutEventSelectors',
		])
			assert.ok(actions.includes(action), `must deny ${action}`)
	})

	it('denies every action taken by the account root user', () => {
		const root = byId('DenyRootUser')
		assert.equal(root.Action, '*')
		assert.equal(root.Condition?.StringLike?.['aws:PrincipalArn'], 'arn:aws:iam::*:root')
	})
})
