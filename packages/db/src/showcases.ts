import type {
	LifecycleState,
	OrderStatus,
	Showcase,
	ShowcaseAdminRow,
	ShowcaseItem,
} from '@mf/models'
import type { Db } from './index.ts'
import type { ShowcasesRepository, ShowcaseUpsert } from './repositories.ts'

// MARK: Row mapping

type ShowcaseRow = {
	order_id: string
	published: boolean
	title: string
	blurb_sv: string
	blurb_en: string
	url: string | null
	sort: number
	created_at: Date
	updated_at: Date
}

/** `showcases` joined with the order columns the admin list shows */
type ShowcaseAdminRowDb = ShowcaseRow & {
	order_name: string
	order_status: OrderStatus
	lifecycle: LifecycleState
}

export const toShowcase = (row: ShowcaseRow): Showcase => ({
	orderId: row.order_id,
	published: row.published,
	title: row.title,
	blurbSv: row.blurb_sv,
	blurbEn: row.blurb_en,
	url: row.url ?? undefined,
	sort: row.sort,
	createdAt: row.created_at.toISOString(),
	updatedAt: row.updated_at.toISOString(),
})

export const toShowcaseAdminRow = (row: ShowcaseAdminRowDb): ShowcaseAdminRow => ({
	...toShowcase(row),
	orderName: row.order_name,
	orderStatus: row.order_status,
	lifecycle: row.lifecycle,
})

/**
 * The public card. Shared with the memory twin so both backends publish the same shape; the
 * caller guarantees `url` (the published-list reads filter on it).
 */
export const toShowcaseItem = (showcase: Showcase & { url: string }): ShowcaseItem => ({
	orderId: showcase.orderId,
	title: showcase.title,
	blurb: { sv: showcase.blurbSv, en: showcase.blurbEn },
	url: showcase.url,
	sort: showcase.sort,
})

// MARK: Queries

/** Insert or replace the order's row (`created_at` is kept on update) */
export const upsertShowcase = async (db: Db, showcase: ShowcaseUpsert): Promise<Showcase> => {
	const [row] = await db.sql<ShowcaseRow[]>`
		insert into showcases (order_id, published, title, blurb_sv, blurb_en, url, sort)
		values (
			${showcase.orderId}, ${showcase.published}, ${showcase.title}, ${showcase.blurbSv},
			${showcase.blurbEn}, ${showcase.url}, ${showcase.sort}
		)
		on conflict (order_id) do update set
			published = excluded.published,
			title = excluded.title,
			blurb_sv = excluded.blurb_sv,
			blurb_en = excluded.blurb_en,
			url = excluded.url,
			sort = excluded.sort,
			updated_at = now()
		returning *`
	return toShowcase(row!)
}

export const getShowcaseByOrder = async (
	db: Db,
	orderId: string
): Promise<Showcase | undefined> => {
	const [row] = await db.sql<ShowcaseRow[]>`select * from showcases where order_id = ${orderId}`
	return row && toShowcase(row)
}

/** Every row with its order's name/status/lifecycle, gallery order first (admin view) */
export const listShowcases = async (db: Db): Promise<ShowcaseAdminRow[]> => {
	const rows = await db.sql<ShowcaseAdminRowDb[]>`
		select s.*, o.name as order_name, o.status as order_status, o.lifecycle
		from showcases s
		join orders o on o.id = s.order_id
		order by s.sort asc, s.updated_at desc
		limit 200`
	return rows.map(toShowcaseAdminRow)
}

/**
 * The public gallery: published rows with a URL whose order is not torn down — so a teardown
 * hides the demo with no hook of its own. Gallery order (`sort` ascending, then newest change).
 */
export const listPublishedShowcases = async (db: Db): Promise<ShowcaseItem[]> => {
	const rows = await db.sql<(ShowcaseRow & { url: string })[]>`
		select s.*
		from showcases s
		join orders o on o.id = s.order_id
		where s.published and s.url is not null and o.lifecycle <> 'torn_down'
		order by s.sort asc, s.updated_at desc
		limit 200`
	return rows.map(row => toShowcaseItem({ ...toShowcase(row), url: row.url }))
}

export const createShowcasesRepository = (db: Db): ShowcasesRepository => ({
	upsert: showcase => upsertShowcase(db, showcase),
	getByOrder: orderId => getShowcaseByOrder(db, orderId),
	list: () => listShowcases(db),
	listPublished: () => listPublishedShowcases(db),
})
