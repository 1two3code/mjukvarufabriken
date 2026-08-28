/**
 * The service control policy attached to the `Customers` OU. An SCP is a *guardrail*: it never
 * grants anything, it only removes permissions from every principal in the targeted accounts
 * (including that account's own admins, but never the organization's management account). The
 * document below is a plain data structure so it can be unit-tested without synthesising a stack.
 *
 * Global (non-regional) services are exempt from the region lock — their endpoints live in
 * `us-east-1` / are partition-global and would break under a blanket region deny. This is the
 * canonical AWS region-restriction `NotAction` set, trimmed to services a customer account might
 * legitimately touch.
 */
const GLOBAL_SERVICE_ACTIONS = [
	'a4b:*',
	'access-analyzer:*',
	'account:*',
	'acm:*',
	'aws-marketplace-management:*',
	'aws-marketplace:*',
	'aws-portal:*',
	'billing:*',
	'budgets:*',
	'ce:*',
	'chime:*',
	'cloudfront:*',
	'cur:*',
	'globalaccelerator:*',
	'health:*',
	'iam:*',
	'importexport:*',
	'kms:*',
	'mobileanalytics:*',
	'networkmanager:*',
	'organizations:*',
	'pricing:*',
	'route53:*',
	'route53domains:*',
	'route53-recovery-cluster:*',
	'route53-recovery-control-config:*',
	'route53-recovery-readiness:*',
	's3:GetAccountPublicAccessBlock',
	's3:ListAllMyBuckets',
	's3:PutAccountPublicAccessBlock',
	'shield:*',
	'sts:*',
	'support:*',
	'supportapp:*',
	'supportplans:*',
	'trustedadvisor:*',
	'waf-regional:*',
	'waf:*',
	'wafv2:*',
] as const

export type PolicyStatement = {
	Sid: string
	Effect: 'Deny'
	Action?: string | string[]
	NotAction?: string | string[]
	Resource: string | string[]
	Condition?: Record<string, Record<string, string | string[]>>
}

export type PolicyDocument = {
	Version: '2012-10-17'
	Statement: PolicyStatement[]
}

/**
 * Build the Customers-OU SCP for the given allow-list of regions. Four guardrails:
 *  1. Region lock — deny everything outside the allowed regions, except the global services above.
 *  2. Deny `organizations:LeaveOrganization` — a member account can't yank itself out; graduation
 *     is a deliberate `MoveAccount` we run from the management account.
 *  3. Deny turning CloudTrail off or blinding it — the audit trail stays on.
 *  4. Deny the account's root user doing anything — force everything through IAM roles/users.
 */
export const buildCustomersScp = (allowedRegions: string[]): PolicyDocument => ({
	Version: '2012-10-17',
	Statement: [
		{
			Sid: 'RegionLock',
			Effect: 'Deny',
			NotAction: [...GLOBAL_SERVICE_ACTIONS],
			Resource: '*',
			Condition: {
				StringNotEquals: {
					'aws:RequestedRegion': allowedRegions,
				},
			},
		},
		{
			Sid: 'DenyLeaveOrganization',
			Effect: 'Deny',
			Action: 'organizations:LeaveOrganization',
			Resource: '*',
		},
		{
			Sid: 'DenyDisableCloudTrail',
			Effect: 'Deny',
			Action: [
				'cloudtrail:StopLogging',
				'cloudtrail:DeleteTrail',
				'cloudtrail:UpdateTrail',
				'cloudtrail:PutEventSelectors',
			],
			Resource: '*',
		},
		{
			Sid: 'DenyRootUser',
			Effect: 'Deny',
			Action: '*',
			Resource: '*',
			Condition: {
				StringLike: {
					'aws:PrincipalArn': 'arn:aws:iam::*:root',
				},
			},
		},
	],
})
