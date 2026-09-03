import fp from 'fastify-plugin'
import { mergeDeep } from '@mf/utils/object'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { PartialDeep } from 'type-fest'
import type { Showcase, ShowcaseAdminRow, ShowcaseItem } from '@mf/models'
import type { ShowcaseUpsertInput } from '#/services/showcaseService.ts'

const defaultShowcase: Showcase = {
	orderId: 'order-1',
	published: true,
	title: 'Gym booking',
	blurbSv: 'Bokning av pass för ett litet gym.',
	blurbEn: 'Class booking for a small gym.',
	url: 'https://mf-gym-booking-job1.eu-north-1.on.aws',
	sort: 0,
	createdAt: '2026-09-02T10:00:00.000Z',
	updatedAt: '2026-09-02T10:00:00.000Z',
}

const defaultAdminRow: ShowcaseAdminRow = {
	...defaultShowcase,
	orderName: 'Gym booking',
	orderStatus: 'delivered',
	lifecycle: 'active',
}

const defaultItem: ShowcaseItem = {
	orderId: defaultShowcase.orderId,
	title: defaultShowcase.title,
	blurb: { sv: defaultShowcase.blurbSv, en: defaultShowcase.blurbEn },
	url: defaultShowcase.url!,
	sort: defaultShowcase.sort,
}

export const createMockShowcase = (overrides?: PartialDeep<Showcase>): Showcase =>
	mergeDeep(defaultShowcase, overrides)
export const createMockShowcaseAdminRow = (
	overrides?: PartialDeep<ShowcaseAdminRow>
): ShowcaseAdminRow => mergeDeep(defaultAdminRow, overrides)
export const createMockShowcaseItem = (overrides?: PartialDeep<ShowcaseItem>): ShowcaseItem =>
	mergeDeep(defaultItem, overrides)

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['showcaseService'] = {
		listPublished: vi.fn().mockResolvedValue([createMockShowcaseItem()]),
		listAdmin: vi.fn().mockResolvedValue([createMockShowcaseAdminRow()]),
		upsert: vi.fn((orderId: string, input: ShowcaseUpsertInput) =>
			Promise.resolve(createMockShowcase({ orderId, ...input }))
		),
		liveUrlOf: vi.fn().mockResolvedValue(defaultShowcase.url),
	}

	app.decorate('showcaseService', mock)
}

export default fp(mockPlugin, { name: '#internal/showcaseService' })
