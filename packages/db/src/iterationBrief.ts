import type { IterationBrief, IterationBriefEntry } from '@mf/models'
import type { Db } from './index.ts'
import type { IterationBriefRepository } from './repositories.ts'

// MARK: Row mapping

type BriefRow = {
	org_id: string
	project_id: string
	title: string | null
	entries: IterationBriefEntry[]
	created_at: Date
	updated_at: Date
}

export const toIterationBrief = (row: BriefRow): IterationBrief => ({
	orgId: row.org_id,
	projectId: row.project_id,
	title: row.title ?? undefined,
	entries: row.entries,
	createdAt: row.created_at.toISOString(),
	updatedAt: row.updated_at.toISOString(),
})

// MARK: Reads

export const getIterationBrief = async (
	db: Db,
	orgId: string,
	projectId: string
): Promise<IterationBrief | undefined> => {
	const [row] = await db.sql<BriefRow[]>`
		select * from iteration_brief where org_id = ${orgId} and project_id = ${projectId}`
	return row && toIterationBrief(row)
}

/** Every brief of the org (or all orgs when `orgId` is omitted), most recently updated first */
export const listIterationBriefs = async (
	db: Db,
	orgId?: string
): Promise<IterationBrief[]> => {
	const { sql } = db
	const rows = await sql<BriefRow[]>`
		select * from iteration_brief
		where true ${orgId === undefined ? sql`` : sql`and org_id = ${orgId}`}
		order by updated_at desc
		limit 500`
	return rows.map(toIterationBrief)
}

// MARK: Append

/**
 * Appends the entry to the brief, creating the row on first contact. `title` is only written on
 * insert (and only when given). One atomic statement: the insert covers a project without a
 * brief, the `do update` concatenates onto the existing `entries` and bumps `updated_at`.
 */
export const appendIterationBriefEntry = async (
	db: Db,
	orgId: string,
	projectId: string,
	entry: IterationBriefEntry,
	title?: string
): Promise<IterationBrief> => {
	const { sql } = db
	const [row] = await sql<BriefRow[]>`
		insert into iteration_brief (org_id, project_id, title, entries)
		values (${orgId}, ${projectId}, ${title ?? null}, ${sql.json([entry] as never)})
		on conflict (org_id, project_id) do update set
			entries = iteration_brief.entries || excluded.entries,
			updated_at = now()
		returning *`
	return toIterationBrief(row!)
}

export const createIterationBriefRepository = (db: Db): IterationBriefRepository => ({
	get: (orgId, projectId) => getIterationBrief(db, orgId, projectId),
	list: orgId => listIterationBriefs(db, orgId),
	appendEntry: (orgId, projectId, entry, title) =>
		appendIterationBriefEntry(db, orgId, projectId, entry, title),
})
