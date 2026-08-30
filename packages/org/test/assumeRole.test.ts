import { AssumeRoleCommand } from '@aws-sdk/client-sts'

import { assumeAccountRole, roleArnFor } from '#/assumeRole.ts'

import type { StsClientLike } from '#/types.ts'

const ACCOUNT = '111111111111'

const stsStub = (credentials?: Record<string, unknown>) => {
	const sent: { name: string; input: Record<string, unknown> }[] = []
	const send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
		sent.push({ name: command.constructor.name, input: command.input })
		if (command instanceof AssumeRoleCommand) {
			return credentials === null
				? {}
				: {
						Credentials: credentials ?? {
							AccessKeyId: 'AKIA',
							SecretAccessKey: 'secret',
							SessionToken: 'token',
							Expiration: new Date('2026-01-01T00:00:00.000Z'),
						},
					}
		}
		throw new Error(`unexpected command ${command.constructor.name}`)
	}
	return { client: { send } as unknown as StsClientLike, sent }
}

describe('assumeAccountRole', () => {
	it('Builds the OrganizationAccountAccessRole ARN', () => {
		expect(roleArnFor(ACCOUNT)).toBe(
			'arn:aws:iam::111111111111:role/OrganizationAccountAccessRole'
		)
	})

	it('Assumes the role and returns temporary credentials', async () => {
		const { client, sent } = stsStub()

		const creds = await assumeAccountRole(ACCOUNT, { client })

		expect(creds).toEqual({
			accountId: ACCOUNT,
			roleArn: 'arn:aws:iam::111111111111:role/OrganizationAccountAccessRole',
			accessKeyId: 'AKIA',
			secretAccessKey: 'secret',
			sessionToken: 'token',
			expiration: '2026-01-01T00:00:00.000Z',
		})
		expect(sent[0].input).toMatchObject({
			RoleArn: 'arn:aws:iam::111111111111:role/OrganizationAccountAccessRole',
			RoleSessionName: 'mf-org-111111111111',
			DurationSeconds: 3600,
		})
	})

	it('Honours a custom role name, session name and external id', async () => {
		const { client, sent } = stsStub()

		await assumeAccountRole(ACCOUNT, {
			client,
			roleName: 'mf-deploy',
			sessionName: 'onboarding',
			externalId: 'ext-1',
			durationSeconds: 900,
		})

		expect(sent[0].input).toMatchObject({
			RoleArn: 'arn:aws:iam::111111111111:role/mf-deploy',
			RoleSessionName: 'onboarding',
			ExternalId: 'ext-1',
			DurationSeconds: 900,
		})
	})

	it('Throws when STS returns no credentials', async () => {
		const { client } = stsStub(null as unknown as undefined)
		await expect(assumeAccountRole(ACCOUNT, { client })).rejects.toThrow(/no credentials/)
	})

	it('Rejects a malformed account id', async () => {
		const { client } = stsStub()
		await expect(assumeAccountRole('nope', { client })).rejects.toThrow()
	})
})
