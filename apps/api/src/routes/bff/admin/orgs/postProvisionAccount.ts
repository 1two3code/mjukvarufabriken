import { z } from 'zod'
import { ProvisionAccountResponseSchema } from '@mf/models'
import { tryCatch } from '@mf/utils/function'

import { EntityNotFound } from '#/lib/entityError.ts'
import { OrgNotConfigured } from '#/plugins/org.ts'

import type { FastifyContextConfig } from 'fastify'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
	params: z.object({ orgId: z.string() }),
	response: { 200: ProvisionAccountResponseSchema },
}

const config = { permissions: ['job:admin'] } satisfies FastifyContextConfig

/**
 * Onboarding step (wave 9, org-accounts.md #4): vend (or reuse) the customer's AWS account and
 * record it on the org. Behind the `PROVISION_CUSTOMER_ACCOUNTS` flag — a no-op that records
 * nothing until enabled (the response says so via `skipped`), and idempotent once an account is set.
 */
const route: FastifyPluginAsyncZod = async function (app) {
	const { accountService } = app

	app.post('/bff/admin/orgs/:orgId/provision-account', { schema, config }, async (request, reply) => {
		const [error, result] = await tryCatch(
			accountService.provisionCustomerAccount(request.params.orgId)
		)
		if (error instanceof EntityNotFound) return reply.error(404, error)
		// The operator turned the flag on without wiring the AWS clients — a misconfiguration, not a 500.
		if (error instanceof OrgNotConfigured) return reply.error(409, error)
		if (error) return reply.error(500, error)
		return reply.send(result)
	})
}

export default route
