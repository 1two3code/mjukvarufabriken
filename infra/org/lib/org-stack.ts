import { CfnOutput, Stack, Tags } from 'aws-cdk-lib'
import { CfnOrganizationalUnit, CfnPolicy } from 'aws-cdk-lib/aws-organizations'

import { buildCustomersScp } from './customers-scp.ts'

import type { StackProps } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import type { OrgConfig } from './config.ts'

export type OrgStackProps = StackProps & {
	config: OrgConfig
}

/**
 * The org governance layer, deployed ONCE into the management account (814967776290). It does not
 * touch the management account itself — an SCP never applies to the org's management account — it
 * only creates the `Customers` OU that every vended account is moved into, and the guardrail SCP
 * that then governs those accounts.
 *
 * Everything here is an AWS::Organizations L1 resource. The organization, its root and SERVICE_
 * CONTROL_POLICY policy-type enablement already exist (see docs/backlog/org-accounts.md); this
 * stack owns only the OU and the policy. The root id is configuration (default `r-hh2k`), so
 * `cdk synth` never calls `organizations:ListRoots` and stays green offline.
 */
export class OrgStack extends Stack {
	readonly customersOu: CfnOrganizationalUnit
	readonly scp: CfnPolicy

	constructor(scope: Construct, id: string, { config, ...props }: OrgStackProps) {
		super(scope, id, props)

		this.customersOu = new CfnOrganizationalUnit(this, 'CustomersOu', {
			name: 'Customers',
			parentId: config.rootId,
		})

		this.scp = new CfnPolicy(this, 'CustomersGuardrail', {
			name: 'mf-customers-guardrail',
			description:
				'Region-lock + leave-org / cloudtrail / root-user denies for every vended customer account',
			type: 'SERVICE_CONTROL_POLICY',
			content: buildCustomersScp(config.allowedRegions),
			targetIds: [this.customersOu.attrId],
		})

		Tags.of(this).add('project', 'mjukvaruhuset')
		Tags.of(this).add('component', 'org-governance')

		new CfnOutput(this, 'CustomersOuId', {
			value: this.customersOu.attrId,
			description: 'Id of the Customers OU — vendAccount() moves new accounts into this',
		})
		new CfnOutput(this, 'CustomersScpId', {
			value: this.scp.attrId,
			description: 'Id of the guardrail SCP attached to the Customers OU',
		})
	}
}
