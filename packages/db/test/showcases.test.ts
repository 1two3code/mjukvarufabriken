import { createMemoryRepositories } from '#/memory.ts'
import { toShowcase, toShowcaseAdminRow, toShowcaseItem } from '#/showcases.ts'

import type { ShowcaseUpsert } from '#/repositories.ts'

const at = new Date('2026-09-02T10:00:00Z')

const row = {
	order_id: 'o1',
	published: true,
	title: 'Gym booking',
	blurb_sv: 'Boka pass',
	blurb_en: 'Book classes',
	url: 'https://gym.example',
	sort: 2,
	created_at: at,
	updated_at: at,
}

const upsert = (overrides: Partial<ShowcaseUpsert> = {}): ShowcaseUpsert => ({
	orderId: 'o1',
	published: true,
	title: 'Gym booking',
	blurbSv: 'Boka pass',
	blurbEn: 'Book classes',
	url: 'https://gym.example',
	sort: 0,
	...overrides,
})

describe('showcases repository', () => {
	describe('row mapping', () => {
		it('Maps a row, a null url to undefined, and the admin join columns', () => {
			expect(toShowcase({ ...row, url: null })).toEqual({
				orderId: 'o1',
				published: true,
				title: 'Gym booking',
				blurbSv: 'Boka pass',
				blurbEn: 'Book classes',
				url: undefined,
				sort: 2,
				createdAt: '2026-09-02T10:00:00.000Z',
				updatedAt: '2026-09-02T10:00:00.000Z',
			})
			expect(
				toShowcaseAdminRow({
					...row,
					order_name: 'Gym',
					order_status: 'delivered',
					lifecycle: 'active',
				})
			).toMatchObject({
				orderId: 'o1',
				orderName: 'Gym',
				orderStatus: 'delivered',
				lifecycle: 'active',
			})
		})

		it('Publishes only the public card fields', () => {
			expect(toShowcaseItem({ ...toShowcase(row), url: row.url })).toEqual({
				orderId: 'o1',
				title: 'Gym booking',
				blurb: { sv: 'Boka pass', en: 'Book classes' },
				url: 'https://gym.example',
				sort: 2,
			})
		})
	})

	describe('memory backend', () => {
		const seed = async () => {
			const repos = createMemoryRepositories()
			await repos.orders.insert({ id: 'o1', orgId: 'org', name: 'Gym' })
			await repos.orders.insert({ id: 'o2', orgId: 'org', name: 'Bakery' })
			await repos.orders.insert({ id: 'o3', orgId: 'org', name: 'Workshop' })
			return repos
		}

		it('Upserts one row per order, keeping createdAt on replace', async () => {
			const repos = await seed()
			const created = await repos.showcases.upsert(upsert())
			const replaced = await repos.showcases.upsert(upsert({ title: 'Gym booking v2', url: null }))

			expect(created).toMatchObject({
				orderId: 'o1',
				title: 'Gym booking',
				url: 'https://gym.example',
			})
			expect(replaced).toMatchObject({ orderId: 'o1', title: 'Gym booking v2', url: undefined })
			expect(replaced.createdAt).toBe(created.createdAt)
			await expect(repos.showcases.getByOrder('o1')).resolves.toEqual(replaced)
			await expect(repos.showcases.getByOrder('nope')).resolves.toBeUndefined()
		})

		it('Lists every row with its order name/status/lifecycle for the admin', async () => {
			const repos = await seed()
			await repos.showcases.upsert(upsert({ orderId: 'o2', published: false, sort: 1 }))
			await repos.showcases.upsert(upsert({ orderId: 'o1', sort: 0 }))
			await repos.orders.transition('o1', ['drafting'], 'ready')

			const rows = await repos.showcases.list()

			expect(rows.map(r => r.orderId)).toEqual(['o1', 'o2'])
			expect(rows[0]).toMatchObject({ orderName: 'Gym', orderStatus: 'ready', lifecycle: 'active' })
			expect(rows[1]).toMatchObject({ orderName: 'Bakery', published: false })
		})

		it('Publishes only published rows with a url whose order is active, in gallery order', async () => {
			const repos = await seed()
			await repos.showcases.upsert(upsert({ orderId: 'o1', sort: 5 }))
			await repos.showcases.upsert(upsert({ orderId: 'o2', sort: 1 }))
			await repos.showcases.upsert(upsert({ orderId: 'o3', sort: 0 }))
			await repos.orders.insert({ id: 'o4', orgId: 'org', name: 'Draft' })
			await repos.showcases.upsert(upsert({ orderId: 'o4', published: false }))
			await repos.orders.insert({ id: 'o5', orgId: 'org', name: 'No url' })
			await repos.showcases.upsert(upsert({ orderId: 'o5', published: false, url: null }))
			await repos.orders.insert({ id: 'o6', orgId: 'org', name: 'Suspended' })
			await repos.showcases.upsert(upsert({ orderId: 'o6', sort: 0 }))
			// o3 is torn down and o6 suspended after being published — a suspend deletes the compute
			// too, so both must vanish without any showcase write
			await repos.orders.setLifecycle('o3', ['active'], 'torn_down')
			await repos.orders.setLifecycle('o6', ['active'], 'suspended')

			const items = await repos.showcases.listPublished()

			expect(items.map(item => item.orderId)).toEqual(['o2', 'o1'])
			expect(items[0]).toEqual({
				orderId: 'o2',
				title: 'Gym booking',
				blurb: { sv: 'Boka pass', en: 'Book classes' },
				url: 'https://gym.example',
				sort: 1,
			})
		})

		it('Lists a suspended order again once it is resumed, with no showcase write', async () => {
			const repos = await seed()
			await repos.showcases.upsert(upsert({ orderId: 'o1', sort: 0 }))
			await repos.orders.setLifecycle('o1', ['active'], 'suspended')
			await expect(repos.showcases.listPublished()).resolves.toEqual([])

			await repos.orders.setLifecycle('o1', ['suspended'], 'active')

			const items = await repos.showcases.listPublished()

			expect(items.map(item => item.orderId)).toEqual(['o1'])
		})
	})
})
