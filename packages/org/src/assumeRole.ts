import { AssumeRoleCommand } from '@aws-sdk/client-sts'

import { ROLE_NAME } from '#/constants.ts'
import { AccountIdSchema } from '#/schemas.ts'

import type { StsClientLike } from '#/types.ts'

/** The ARN of the cross-account role in a member account. */
export const roleArnFor = (accountId: string, roleName = ROLE_NAME) =>
	`arn:aws:iam::${accountId}:role/${roleName}`

export type AssumeAccountRoleOptions = {
	client: StsClientLike
	/** Role to assume (default `OrganizationAccountAccessRole`). */
	roleName?: string
	/** Session name (default `mf-org-<accountId>`), surfaced in the member account's CloudTrail. */
	sessionName?: string
	/** Credential lifetime in seconds (default 3600). */
	durationSeconds?: number
	/** Optional external id, when the trust policy requires one. */
	externalId?: string
}

/** Temporary credentials shaped for handing to a CDK/SDK call into the member account. */
export type AccountCredentials = {
	accountId: string
	roleArn: string
	accessKeyId: string
	secretAccessKey: string
	sessionToken: string
	/** ISO expiry, when STS returned one. */
	expiration?: string
}

/**
 * STS `AssumeRole` into a member account's `OrganizationAccountAccessRole`, returning temporary
 * credentials for the deploy/SDK calls that operate that account.
 */
export const assumeAccountRole = async (
	accountId: string,
	options: AssumeAccountRoleOptions
): Promise<AccountCredentials> => {
	const id = AccountIdSchema.parse(accountId)
	const roleArn = roleArnFor(id, options.roleName)
	const result = await options.client.send(
		new AssumeRoleCommand({
			RoleArn: roleArn,
			RoleSessionName: options.sessionName ?? `mf-org-${id}`,
			DurationSeconds: options.durationSeconds ?? 3600,
			ExternalId: options.externalId,
		})
	)
	const credentials = result.Credentials
	if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
		throw new Error(`assume-role: STS returned no credentials for ${roleArn}`)
	}
	return {
		accountId: id,
		roleArn,
		accessKeyId: credentials.AccessKeyId,
		secretAccessKey: credentials.SecretAccessKey,
		sessionToken: credentials.SessionToken,
		expiration: credentials.Expiration?.toISOString(),
	}
}
