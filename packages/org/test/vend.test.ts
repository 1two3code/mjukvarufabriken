import {
	CreateAccountCommand,
	DescribeCreateAccountStatusCommand,
	ListAccountsCommand,
	ListParentsCommand,
	MoveAccountCommand,
} from '@aws-sdk/client-organizations'

import {
	accountNameFor,
	graduateAccount,
	moveToCustomerOu,
	rootEmailFor,
	vendAccount,
} from '#/vend.ts'

import type { OrganizationsClientLike } from '#/types.ts'

// MARK: Fixtures

type Sent = { name: string; input: Record<string, unknown> }

type OrgStubOptions = {
	/** Accounts `ListAccounts` returns (drives the idempotent reuse path). */
	accounts?: { Id: string; Name?: string; Email?: string; Status?: string }[]
	/** The `DescribeCreateAccountStatus` states to answer with, in order (last one repeats). */
	states?: { State: string; AccountId?: string; FailureReason?: string }[]
	/** Current parent id for `ListParents`. */
	parent?: string
}

const NEW_ID = '111111111111'

const orgStub = (options: OrgStubOptions = {}) => {
	const { accounts = [], states = [{ State: 'SUCCEEDED', AccountId: NEW_ID }], parent = 'r-root' } =
		options
	const sent: Sent[] = []
	let describes = 0

	const send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
		sent.push({ name: command.constructor.name, input: command.input })
		if (command instanceof ListAccountsCommand) return { Accounts: accounts }
		if (command instanceof CreateAccountCommand) {
			return { CreateAccountStatus: { Id: 'car-req-1', State: 'IN_PROGRESS' } }
		}
		if (command instanceof DescribeCreateAccountStatusCommand) {
			const state = states[Math.min(describes, states.length - 1)]
			describes += 1
			return { CreateAccountStatus: { Id: 'car-req-1', ...state } }
		}
		if (command instanceof ListParentsCommand) return { Parents: [{ Id: parent, Type: 'ROOT' }] }
		if (command instanceof MoveAccountCommand) return {}
		throw new Error(`unexpected command ${command.constructor.name}`)
	}

	const client = { send } as unknown as OrganizationsClientLike
	const names = () => sent.map(entry => entry.name)
	return { client, sent, names }
}

const fastSleep = async () => {}

// MARK: Tests

describe('vendAccount', () => {
	it('Derives the account name and root email from the slug', () => {
		expect(accountNameFor('acme')).toBe('mf-customer-acme')
		expect(rootEmailFor('acme')).toBe('aws+acme@mjukvaruhuset.se')
	})

	it('Creates, polls to SUCCEEDED and returns the new account id', async () => {
		const { client, sent, names } = orgStub({
			states: [{ State: 'IN_PROGRESS' }, { State: 'SUCCEEDED', AccountId: NEW_ID }],
		})

		const result = await vendAccount(
			{ customerSlug: 'acme' },
			{ client, sleep: fastSleep, pollIntervalMs: 1 }
		)

		expect(result).toEqual({ accountId: NEW_ID, reused: false, requestId: 'car-req-1' })
		expect(names()).toEqual([
			'ListAccountsCommand',
			'CreateAccountCommand',
			'DescribeCreateAccountStatusCommand',
			'DescribeCreateAccountStatusCommand',
		])
		const create = sent.find(entry => entry.name === 'CreateAccountCommand')
		expect(create?.input).toMatchObject({
			AccountName: 'mf-customer-acme',
			Email: 'aws+acme@mjukvaruhuset.se',
			RoleName: 'OrganizationAccountAccessRole',
		})
	})

	it('Reuses an existing account for the slug instead of creating a second (idempotent)', async () => {
		const { client, names } = orgStub({
			accounts: [{ Id: '222222222222', Name: 'mf-customer-acme', Status: 'ACTIVE' }],
		})

		const result = await vendAccount({ customerSlug: 'acme' }, { client, sleep: fastSleep })

		expect(result).toEqual({ accountId: '222222222222', reused: true })
		expect(names()).toEqual(['ListAccountsCommand'])
		expect(names()).not.toContain('CreateAccountCommand')
	})

	it('Surfaces the AWS failure reason when creation FAILS', async () => {
		const { client } = orgStub({
			states: [{ State: 'FAILED', FailureReason: 'EMAIL_ALREADY_EXISTS' }],
		})

		await expect(
			vendAccount({ customerSlug: 'acme' }, { client, sleep: fastSleep })
		).rejects.toThrow(/EMAIL_ALREADY_EXISTS/)
	})

	it('Times out if the account never reaches a terminal state', async () => {
		const { client } = orgStub({ states: [{ State: 'IN_PROGRESS' }] })
		let clock = 0
		const now = () => (clock += 10_000) // each read jumps 10s

		await expect(
			vendAccount(
				{ customerSlug: 'acme' },
				{ client, sleep: fastSleep, now, timeoutMs: 5_000, pollIntervalMs: 1 }
			)
		).rejects.toThrow(/timed out/)
	})

	it('Aborts the poll when the signal is already aborted', async () => {
		const { client } = orgStub({ states: [{ State: 'IN_PROGRESS' }] })
		await expect(
			vendAccount(
				{ customerSlug: 'acme' },
				{ client, sleep: fastSleep, signal: AbortSignal.abort() }
			)
		).rejects.toThrow(/aborted/)
	})

	it('Rejects an invalid slug before any AWS call', async () => {
		const { client, sent } = orgStub()
		await expect(vendAccount({ customerSlug: 'Bad Slug!' }, { client })).rejects.toThrow()
		expect(sent).toHaveLength(0)
	})
})

describe('moveToCustomerOu', () => {
	it('Moves the account from Root into the Customers OU', async () => {
		const { client, sent, names } = orgStub({ parent: 'r-root' })

		const result = await moveToCustomerOu(NEW_ID, { client, customerOuId: 'ou-cust' })

		expect(result).toEqual({
			accountId: NEW_ID,
			movedFrom: 'r-root',
			movedTo: 'ou-cust',
			moved: true,
		})
		expect(names()).toEqual(['ListParentsCommand', 'MoveAccountCommand'])
		const move = sent.find(entry => entry.name === 'MoveAccountCommand')
		expect(move?.input).toMatchObject({
			AccountId: NEW_ID,
			SourceParentId: 'r-root',
			DestinationParentId: 'ou-cust',
		})
	})

	it('Is a no-op when the account is already in the Customers OU (idempotent)', async () => {
		const { client, names } = orgStub({ parent: 'ou-cust' })

		const result = await moveToCustomerOu(NEW_ID, { client, customerOuId: 'ou-cust' })

		expect(result.moved).toBe(false)
		expect(names()).toEqual(['ListParentsCommand'])
	})
})

describe('graduateAccount', () => {
	it('Moves the account back to Root and returns the manual removal step', async () => {
		const { client, names } = orgStub({ parent: 'ou-cust' })

		const result = await graduateAccount(NEW_ID, { client, rootId: 'r-root' })

		expect(result.moved).toBe(true)
		expect(result.movedTo).toBe('r-root')
		expect(result.manualStep).toContain('remove-account-from-organization')
		expect(result.manualStep).toContain(NEW_ID)
		expect(names()).toEqual(['ListParentsCommand', 'MoveAccountCommand'])
	})

	it('Never calls RemoveAccountFromOrganization, and does not move on dry-run', async () => {
		const { client, names } = orgStub({ parent: 'ou-cust' })

		const result = await graduateAccount(NEW_ID, { client, rootId: 'r-root', dryRun: true })

		expect(result.moved).toBe(false)
		expect(names()).toEqual(['ListParentsCommand'])
		expect(names()).not.toContain('RemoveAccountFromOrganizationCommand')
	})
})
