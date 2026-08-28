import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { App } from 'aws-cdk-lib'
import { Match, Template } from 'aws-cdk-lib/assertions'

import { DEFAULT_ROOT_ID, loadConfig } from '../lib/config.ts'
import { OrgStack } from '../lib/org-stack.ts'

const synth = (context: Record<string, string> = {}) => {
	const app = new App({ context })
	const config = loadConfig(app)
	const stack = new OrgStack(app, 'mf-org', { config })
	return { config, template: Template.fromStack(stack) }
}

describe('OrgStack', () => {
	const { config, template } = synth()

	it('synthesises offline with the recorded root id, no context or AWS calls needed', () => {
		assert.equal(config.rootId, DEFAULT_ROOT_ID)
	})

	it('creates the Customers OU under the org root', () => {
		template.resourceCountIs('AWS::Organizations::OrganizationalUnit', 1)
		template.hasResourceProperties('AWS::Organizations::OrganizationalUnit', {
			Name: 'Customers',
			ParentId: DEFAULT_ROOT_ID,
		})
	})

	it('attaches exactly one SCP, targeted at the Customers OU', () => {
		template.resourceCountIs('AWS::Organizations::Policy', 1)
		const ou = Object.keys(template.findResources('AWS::Organizations::OrganizationalUnit'))[0]
		template.hasResourceProperties('AWS::Organizations::Policy', {
			Type: 'SERVICE_CONTROL_POLICY',
			Name: 'mf-customers-guardrail',
			TargetIds: [{ 'Fn::GetAtt': [ou, 'Id'] }],
			Content: Match.objectLike({
				Version: '2012-10-17',
				Statement: Match.arrayWith([
					Match.objectLike({ Sid: 'RegionLock', Effect: 'Deny' }),
					Match.objectLike({ Sid: 'DenyLeaveOrganization', Effect: 'Deny' }),
					Match.objectLike({ Sid: 'DenyDisableCloudTrail', Effect: 'Deny' }),
					Match.objectLike({ Sid: 'DenyRootUser', Effect: 'Deny' }),
				]),
			}),
		})
	})

	it('honours a custom root id and region allow-list from context', () => {
		const custom = synth({ rootId: 'r-test', allowedRegions: 'eu-north-1' })
		custom.template.hasResourceProperties('AWS::Organizations::OrganizationalUnit', {
			ParentId: 'r-test',
		})
		custom.template.hasResourceProperties('AWS::Organizations::Policy', {
			Content: Match.objectLike({
				Statement: Match.arrayWith([
					Match.objectLike({
						Sid: 'RegionLock',
						Condition: { StringNotEquals: { 'aws:RequestedRegion': ['eu-north-1'] } },
					}),
				]),
			}),
		})
	})
})
