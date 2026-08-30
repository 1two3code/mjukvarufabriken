import fp from 'fastify-plugin'
import { allocateInfraCost } from '@mf/models'
import { mergeDeep } from '@mf/utils/object'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { PartialDeep } from 'type-fest'
import type { CustomerRevenue } from '@mf/models'

const defaultRevenue: CustomerRevenue = {
	orgId: 'org-1',
	orgName: 'Acme AB',
	buildFeeSek: 45_000,
	hostingSek: 0,
	slaSek: 0,
	furtherDevSek: 0,
	residentBillableUsd: 20.25,
}

export const createMockCustomerRevenue = (
	overrides?: PartialDeep<CustomerRevenue>
): CustomerRevenue => mergeDeep(defaultRevenue, overrides)

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['marginService'] = {
		infraCostAllocation: vi.fn().mockResolvedValue(allocateInfraCost(['org-1'])),
		revenueByCustomer: vi.fn().mockResolvedValue([createMockCustomerRevenue()]),
	}

	app.decorate('marginService', mock)
}

export default fp(mockPlugin, { name: '#internal/marginService' })
