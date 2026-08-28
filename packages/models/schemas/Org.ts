import { z } from 'zod'

/**
 * A customer organisation. Every user belongs to exactly one org; the first user signing in
 * from a new email domain creates it (see the api `userService`).
 */
export const OrgSchema = z.object({
	id: z.string(),
	name: z.string().min(1),
	/**
	 * The vended per-customer AWS account id (docs/backlog/org-accounts.md #4), recorded by the
	 * onboarding `provisionCustomerAccount` step. Absent until an account is vended for the org
	 * (the step is behind a flag and a no-op until enabled). Delivery/resident target this account.
	 */
	awsAccountId: z.string().optional(),
	/** The slug the account was vended under (`mf-customer-<slug>`); absent until vended. */
	awsAccountSlug: z.string().optional(),
	createdAt: z.iso.datetime(),
})

export type Org = z.infer<typeof OrgSchema>
