import { claimQuote, getOrder, getOrderByQuoteToken, getOrderRecord } from '#/orders.ts'

import type { Db } from '#/index.ts'

/** A Db whose sql throws on use: the guards must return before touching Postgres */
const untouchable = {
	sql: () => {
		throw new Error('sql must not be called')
	},
} as unknown as Db

describe('orders repository', () => {
	it('Treats a malformed order id as not found without querying (uuid column)', async () => {
		const owner = { orgId: 'org-1', userId: 'user-1' }

		await expect(getOrder(untouchable, 'not-a-uuid')).resolves.toBeUndefined()
		await expect(getOrderRecord(untouchable, 'not-a-uuid')).resolves.toBeUndefined()
		await expect(getOrderByQuoteToken(untouchable, 'not-a-uuid', 'h')).resolves.toBeUndefined()
		await expect(claimQuote(untouchable, "' or 1=1 --", 'h', owner)).resolves.toBeUndefined()
	})
})
