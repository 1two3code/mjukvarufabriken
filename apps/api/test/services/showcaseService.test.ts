import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob, createMockJobEvent } from '#/plugins/__mocks__/db.ts'
import { createMockDeliverable } from '#/services/__mocks__/jobService.ts'
import {
	ShowcaseNoLiveUrl,
	showcaseRateLimit,
	ShowcaseRateLimited,
	showcaseRateLimitScope,
} from '#/services/showcaseService.ts'

import type { FastifyInstance } from 'fastify'
import type { JobEvent } from '@mf/models'
import type { ShowcaseUpsertInput } from '#/services/showcaseService.ts'

const ip = '203.0.113.7'
const liveUrl = 'https://mf-gym-booking-job2.eu-north-1.on.aws'

const input = (overrides: Partial<ShowcaseUpsertInput> = {}): ShowcaseUpsertInput => ({
	published: true,
	title: 'Gym booking',
	blurbSv: 'Boka pass',
	blurbEn: 'Book classes',
	sort: 0,
	...overrides,
})

/** The final `bundle` delivery event of a job, carrying (or withholding) the live URL */
const bundleEvent = (jobId: string, deployUrl: string | null): JobEvent =>
	createMockJobEvent({
		jobId,
		type: 'delivery',
		payload: {
			step: 'bundle',
			ok: true,
			deliverable: createMockDeliverable({ jobId, deployUrl }),
		},
	})

describe('Showcase Service', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/services/showcaseService.ts' })
		await app.db.orders.insert({ id: 'order-1', orgId: 'org-1', name: 'Gym booking' })
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe('upsert', () => {
		it('Stores the row with the supplied url', async () => {
			// Act
			const showcase = await app.showcaseService.upsert(
				'order-1',
				input({ url: 'https://gym.example' })
			)

			// Assert
			expect(showcase).toMatchObject({
				orderId: 'order-1',
				published: true,
				title: 'Gym booking',
				url: 'https://gym.example',
			})
			await expect(app.db.showcases.getByOrder('order-1')).resolves.toEqual(showcase)
			expect(app.db.jobs.list).not.toHaveBeenCalled()
		})

		it('Resolves a missing url from the newest delivered job whose bundle carried one', async () => {
			// Arrange: newest first — a failed rebuild, a delivered redelivery with a URL, an old
			// delivery whose URL was withheld
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([
				createMockJob({ id: 'job-3', orderId: 'order-1', status: 'failed' }),
				createMockJob({ id: 'job-2', orderId: 'order-1', status: 'delivered' }),
				createMockJob({ id: 'job-1', orderId: 'order-1', status: 'delivered' }),
			])
			vi.spyOn(app.db.jobs, 'listEvents').mockImplementation(jobId =>
				Promise.resolve(jobId === 'job-2' ? [bundleEvent('job-2', liveUrl)] : [])
			)

			// Act
			const showcase = await app.showcaseService.upsert('order-1', input())

			// Assert
			expect(showcase.url).toBe(liveUrl)
			expect(app.db.jobs.list).toHaveBeenCalledWith({ orderId: 'order-1' })
			// The failed job's events are never read
			expect(app.db.jobs.listEvents).not.toHaveBeenCalledWith('job-3')
		})

		it('Skips a delivered job whose URL was withheld and falls through to an older one', async () => {
			// Arrange
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([
				createMockJob({ id: 'job-2', orderId: 'order-1', status: 'delivered' }),
				createMockJob({ id: 'job-1', orderId: 'order-1', status: 'delivered' }),
			])
			vi.spyOn(app.db.jobs, 'listEvents').mockImplementation(jobId =>
				Promise.resolve([bundleEvent(jobId, jobId === 'job-1' ? liveUrl : null)])
			)

			// Act
			await expect(app.showcaseService.liveUrlOf('order-1')).resolves.toBe(liveUrl)
		})

		it('Refuses to publish without any live url, but stores a draft without one', async () => {
			// Arrange
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([])

			// Act + Assert
			await expect(app.showcaseService.upsert('order-1', input())).rejects.toBeInstanceOf(
				ShowcaseNoLiveUrl
			)
			await expect(app.db.showcases.getByOrder('order-1')).resolves.toBeUndefined()

			const draft = await app.showcaseService.upsert('order-1', input({ published: false }))
			expect(draft).toMatchObject({ published: false, url: undefined })
		})

		it('Rejects an unknown order with EntityNotFound before touching jobs', async () => {
			await expect(app.showcaseService.upsert('nope', input())).rejects.toBeInstanceOf(
				EntityNotFound
			)
			expect(app.db.jobs.list).not.toHaveBeenCalled()
		})

		it('Rejects an unclaimed anonymous quote like an unknown order (wave 14)', async () => {
			await app.db.orders.insert({ id: 'quote-1', orgId: `anon:${'0'.repeat(32)}`, name: 'Offert' })

			await expect(app.showcaseService.upsert('quote-1', input())).rejects.toBeInstanceOf(
				EntityNotFound
			)
			expect(app.db.jobs.list).not.toHaveBeenCalled()
		})
	})

	describe('listPublished', () => {
		it('Returns the published gallery and records the hit for the ip', async () => {
			// Arrange
			await app.showcaseService.upsert('order-1', input({ url: liveUrl }))

			// Act
			const items = await app.showcaseService.listPublished(ip)

			// Assert
			expect(items).toEqual([
				{
					orderId: 'order-1',
					title: 'Gym booking',
					blurb: { sv: 'Boka pass', en: 'Book classes' },
					url: liveUrl,
					sort: 0,
				},
			])
			await expect(
				app.db.rateLimits.count(showcaseRateLimitScope, ip, new Date(Date.now() - 60_000))
			).resolves.toBe(1)
		})

		it('Hides a published showcase once its order is suspended or torn down', async () => {
			// Arrange: a suspend deletes the compute (accountService), so the link would be dead
			await app.db.orders.insert({ id: 'order-2', orgId: 'org-1', name: 'Bakery' })
			await app.showcaseService.upsert('order-1', input({ url: liveUrl }))
			await app.showcaseService.upsert('order-2', input({ url: 'https://bakery.example' }))
			await app.db.orders.setLifecycle('order-1', ['active'], 'suspended')
			await app.db.orders.setLifecycle('order-2', ['active'], 'torn_down')

			// Act
			const items = await app.showcaseService.listPublished(ip)

			// Assert: no showcase write was needed for either to vanish
			expect(items).toEqual([])
			await expect(app.db.showcases.getByOrder('order-1')).resolves.toMatchObject({
				published: true,
			})
		})

		it('Rate-limits an ip within the window and resumes after it', async () => {
			// Arrange
			vi.useFakeTimers({ toFake: ['Date'] })
			vi.setSystemTime(new Date('2026-09-02T10:00:00.000Z'))

			// Act: the cap's worth of reads pass, the next one is refused — other ips are unaffected
			for (let i = 0; i < showcaseRateLimit.max; i++) await app.showcaseService.listPublished(ip)

			// Assert
			await expect(app.showcaseService.listPublished(ip)).rejects.toBeInstanceOf(
				ShowcaseRateLimited
			)
			await expect(app.showcaseService.listPublished('198.51.100.1')).resolves.toEqual([])

			vi.setSystemTime(new Date('2026-09-02T10:01:01.000Z'))
			await expect(app.showcaseService.listPublished(ip)).resolves.toEqual([])
		})
	})

	describe('listAdmin', () => {
		it('Lists every row with its order name/status/lifecycle', async () => {
			// Arrange
			await app.showcaseService.upsert('order-1', input({ published: false, url: liveUrl }))

			// Act
			const rows = await app.showcaseService.listAdmin()

			// Assert
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({
				orderId: 'order-1',
				published: false,
				orderName: 'Gym booking',
				orderStatus: 'drafting',
				lifecycle: 'active',
			})
		})
	})
})
