import {
	CreateAccountCommand,
	DescribeCreateAccountStatusCommand,
	ListAccountsCommand,
	ListParentsCommand,
	MoveAccountCommand,
} from '@aws-sdk/client-organizations'

import { ACCOUNT_NAME_PREFIX, EMAIL_DOMAIN, ROLE_NAME } from '#/constants.ts'
import { AccountIdSchema, SlugSchema } from '#/schemas.ts'
import { abortError, sleep } from '#/signal.ts'

import type { Account } from '@aws-sdk/client-organizations'
import type { Sleep } from '#/signal.ts'
import type { OrganizationsClientLike } from '#/types.ts'

/** Account name for a slug: `mf-customer-<slug>`. */
export const accountNameFor = (slug: string) => `${ACCOUNT_NAME_PREFIX}${slug}`

/** Root email for a slug: `aws+<slug>@<domain>` (needs deliverable catch-all inbound mail). */
export const rootEmailFor = (slug: string, domain = EMAIL_DOMAIN) => `aws+${slug}@${domain}`

// MARK: vendAccount

export type Logger = (message: string, detail?: Record<string, unknown>) => void

export type VendAccountOptions = {
	client: OrganizationsClientLike
	/** Override the root-email domain (default `mjukvaruhuset.se`). */
	emailDomain?: string
	roleName?: string
	/** Poll cadence for `DescribeCreateAccountStatus` (default 5s). */
	pollIntervalMs?: number
	/** Give up after this long (default 5min) — CreateAccount is usually seconds, occasionally minutes. */
	timeoutMs?: number
	/** Abort the poll early (a shutdown, a cancelled onboarding). */
	signal?: AbortSignal
	/** Injectable clock/sleep for tests. */
	now?: () => number
	sleep?: Sleep
	log?: Logger
}

export type VendAccountResult = {
	accountId: string
	/** True when an account for the slug already existed and was returned instead of creating a new one. */
	reused: boolean
	/** The `CreateAccount` request id, when a create actually ran. */
	requestId?: string
}

/**
 * Vend (or reuse) the customer's AWS account.
 *
 * Idempotent: if an account named `mf-customer-<slug>` already exists in the org it is returned
 * rather than creating a second one (root emails must be globally unique anyway). Otherwise
 * `CreateAccount` is issued and `DescribeCreateAccountStatus` polled until `SUCCEEDED` (→ account
 * id) or `FAILED` (→ throw with the AWS failure reason), honouring `signal` and `timeoutMs`.
 */
export const vendAccount = async (
	input: { customerSlug: string },
	options: VendAccountOptions
): Promise<VendAccountResult> => {
	const slug = SlugSchema.parse(input.customerSlug)
	const { client, emailDomain, roleName = ROLE_NAME } = options
	const name = accountNameFor(slug)
	const email = rootEmailFor(slug, emailDomain)

	const existing = await findAccountByNameOrEmail(client, name, email)
	if (existing?.Id) {
		options.log?.('vend: reusing existing account', { slug, accountId: existing.Id })
		return { accountId: AccountIdSchema.parse(existing.Id), reused: true }
	}

	const created = await client.send(
		new CreateAccountCommand({ AccountName: name, Email: email, RoleName: roleName })
	)
	const requestId = created.CreateAccountStatus?.Id
	if (!requestId) throw new Error('vend: CreateAccount returned no request id')

	const accountId = await pollCreateAccount(client, requestId, options)
	options.log?.('vend: account created', { slug, accountId, requestId })
	return { accountId: AccountIdSchema.parse(accountId), reused: false, requestId }
}

/** Paginated `ListAccounts`, matching an ACTIVE/SUSPENDED account by name or email (case-insensitive name). */
const findAccountByNameOrEmail = async (
	client: OrganizationsClientLike,
	name: string,
	email: string
): Promise<Account | undefined> => {
	const wantedName = name.toLowerCase()
	let token: string | undefined
	do {
		const page = await client.send(new ListAccountsCommand({ NextToken: token }))
		const match = (page.Accounts ?? []).find(
			account =>
				account.Status !== 'PENDING_CLOSURE' &&
				(account.Name?.toLowerCase() === wantedName || account.Email === email)
		)
		if (match) return match
		token = page.NextToken || undefined
	} while (token)
	return undefined
}

const pollCreateAccount = async (
	client: OrganizationsClientLike,
	requestId: string,
	options: VendAccountOptions
): Promise<string> => {
	const { pollIntervalMs = 5_000, timeoutMs = 5 * 60_000, signal, now = Date.now } = options
	const wait = options.sleep ?? sleep
	const start = now()
	for (;;) {
		if (signal?.aborted) throw abortError()
		const { CreateAccountStatus: status } = await client.send(
			new DescribeCreateAccountStatusCommand({ CreateAccountRequestId: requestId })
		)
		if (status?.State === 'SUCCEEDED') {
			if (!status.AccountId) throw new Error('vend: SUCCEEDED without an account id')
			return status.AccountId
		}
		if (status?.State === 'FAILED') {
			throw new Error(`vend: account creation failed: ${status.FailureReason ?? 'unknown'}`)
		}
		if (now() - start >= timeoutMs) {
			throw new Error(`vend: timed out after ${timeoutMs}ms waiting for ${requestId}`)
		}
		await wait(pollIntervalMs, signal)
	}
}

// MARK: moveToCustomerOu

export type MoveToCustomerOuOptions = {
	client: OrganizationsClientLike
	/** The `Customers` OU id the account should live under. */
	customerOuId: string
	log?: Logger
}

export type MoveResult = {
	accountId: string
	movedFrom?: string
	movedTo: string
	/** False when the account was already in the target OU (a no-op re-run). */
	moved: boolean
}

/** Move the account from its current parent (Root) into the `Customers` OU. Idempotent. */
export const moveToCustomerOu = async (
	accountId: string,
	{ client, customerOuId, log }: MoveToCustomerOuOptions
): Promise<MoveResult> => {
	const id = AccountIdSchema.parse(accountId)
	const currentParent = await parentOf(client, id)
	if (!currentParent) throw new Error(`move: no parent found for ${id}`)
	if (currentParent === customerOuId) {
		log?.('move: already in customer OU', { accountId: id, customerOuId })
		return { accountId: id, movedFrom: currentParent, movedTo: customerOuId, moved: false }
	}
	await client.send(
		new MoveAccountCommand({
			AccountId: id,
			SourceParentId: currentParent,
			DestinationParentId: customerOuId,
		})
	)
	return { accountId: id, movedFrom: currentParent, movedTo: customerOuId, moved: true }
}

// MARK: graduateAccount

export type GraduateAccountOptions = {
	client: OrganizationsClientLike
	/** Org root id — where the account is moved to (out of the Customers OU) before the manual removal. */
	rootId: string
	/** When true, describe the move without performing it (default false). */
	dryRun?: boolean
	log?: Logger
}

export type GraduateResult = {
	accountId: string
	movedFrom?: string
	movedTo: string
	moved: boolean
	/** The deliberate, human-run removal step — never automated. */
	manualStep: string
}

/**
 * Graduation helper: move the account out of the `Customers` OU back to Root so it is no longer
 * governed by our SCP, then hand back the exact CLI for the deliberate final removal.
 * `RemoveAccountFromOrganization` is intentionally NOT called here — it is a manual step (see
 * docs/backlog/org-accounts.md). Idempotent: a no-op when the account is already at Root.
 */
export const graduateAccount = async (
	accountId: string,
	{ client, rootId, dryRun = false, log }: GraduateAccountOptions
): Promise<GraduateResult> => {
	const id = AccountIdSchema.parse(accountId)
	const currentParent = await parentOf(client, id)
	const manualStep =
		`Deliberate manual step when the customer is ready to leave: ` +
		`aws organizations remove-account-from-organization --account-id ${id} ` +
		`(the account must first have completed the standalone sign-up / billing steps; not automated).`

	const shouldMove = Boolean(currentParent) && currentParent !== rootId
	if (shouldMove && !dryRun) {
		await client.send(
			new MoveAccountCommand({
				AccountId: id,
				SourceParentId: currentParent,
				DestinationParentId: rootId,
			})
		)
	}
	log?.('graduate: prepared account for removal', { accountId: id, movedOut: shouldMove && !dryRun })
	return {
		accountId: id,
		movedFrom: currentParent,
		movedTo: rootId,
		moved: shouldMove && !dryRun,
		manualStep,
	}
}

const parentOf = async (client: OrganizationsClientLike, childId: string) => {
	const parents = await client.send(new ListParentsCommand({ ChildId: childId }))
	return parents.Parents?.[0]?.Id
}
