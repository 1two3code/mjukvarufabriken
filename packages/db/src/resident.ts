import type {
	ResidentInstallation,
	ResidentUsageRecord,
	ResidentUsageReport,
	ResidentUsageSummary,
} from '@mf/models'
import type { Db } from './index.ts'
import type {
	NewResidentUsageReport,
	ResidentInstallationUpsert,
	ResidentRepository,
	ResidentUsageFilter,
} from './repositories.ts'

// MARK: Row mapping

type InstallationRow = {
	id: string
	org_id: string | null
	billing_customer_id: string | null
	created_at: Date
	updated_at: Date
}

type UsageRow = {
	record: ResidentUsageRecord
}

type SummaryRow = {
	installation_id: string
	org_id: string | null
	month: string
	repository: string
	days: number | string
	total_tokens: number | string
	list_price_usd: number
	billable_usd: number
	tasks_started: number | string
	tasks_succeeded: number | string
	tasks_failed: number | string
	pull_requests_opened: number | string
	cap_tokens: number | string
	cap_used_tokens: number | string
}

type ReportRow = {
	installation_id: string
	month: string
	usd_cents: number | string
	provider: ResidentUsageReport['provider']
	reference: string | null
	reported_at: Date
}

export const toResidentInstallation = (row: InstallationRow): ResidentInstallation => ({
	id: row.id,
	orgId: row.org_id ?? undefined,
	billingCustomerId: row.billing_customer_id ?? undefined,
	createdAt: row.created_at.toISOString(),
	updatedAt: row.updated_at.toISOString(),
})

export const toResidentUsageReport = (row: ReportRow): ResidentUsageReport => ({
	installationId: row.installation_id,
	month: row.month,
	usdCents: Number(row.usd_cents),
	provider: row.provider,
	reference: row.reference ?? undefined,
	reportedAt: row.reported_at.toISOString(),
})

/** Sums come back as bigint/numeric strings from Postgres; the summary carries numbers */
export const toResidentUsageSummary = (row: SummaryRow): ResidentUsageSummary => ({
	installationId: row.installation_id,
	orgId: row.org_id ?? undefined,
	repository: row.repository,
	month: row.month,
	days: Number(row.days),
	totalTokens: Number(row.total_tokens),
	listPriceUsd: Number(row.list_price_usd),
	billableUsd: Number(row.billable_usd),
	tasks: {
		started: Number(row.tasks_started),
		succeeded: Number(row.tasks_succeeded),
		failed: Number(row.tasks_failed),
		pullRequestsOpened: Number(row.pull_requests_opened),
	},
	monthlyCap: { tokens: Number(row.cap_tokens), usedTokens: Number(row.cap_used_tokens) },
})

// MARK: Installations

export const getResidentInstallation = async (
	db: Db,
	id: string
): Promise<ResidentInstallation | undefined> => {
	const [row] = await db.sql<InstallationRow[]>`
		select * from resident_installations where id = ${id}`
	return row && toResidentInstallation(row)
}

export const listResidentInstallations = async (db: Db): Promise<ResidentInstallation[]> => {
	const rows = await db.sql<InstallationRow[]>`
		select * from resident_installations order by created_at desc limit 500`
	return rows.map(toResidentInstallation)
}

/**
 * Creates the installation or updates the given fields: `undefined` keeps the stored value,
 * `null` clears it
 */
export const upsertResidentInstallation = async (
	db: Db,
	upsert: ResidentInstallationUpsert
): Promise<ResidentInstallation> => {
	const { sql } = db
	const keepOrg = upsert.orgId === undefined
	const keepCustomer = upsert.billingCustomerId === undefined
	const [row] = await sql<InstallationRow[]>`
		insert into resident_installations (id, org_id, billing_customer_id)
		values (${upsert.id}, ${upsert.orgId ?? null}, ${upsert.billingCustomerId ?? null})
		on conflict (id) do update set
			org_id = ${keepOrg ? sql`resident_installations.org_id` : sql`excluded.org_id`},
			billing_customer_id = ${
				keepCustomer
					? sql`resident_installations.billing_customer_id`
					: sql`excluded.billing_customer_id`
			},
			updated_at = now()
		returning *`
	return toResidentInstallation(row!)
}

// MARK: Usage records

/** Stores the day's record; the installation row is created on first contact (unlinked) */
export const upsertResidentUsage = async (
	db: Db,
	record: ResidentUsageRecord
): Promise<ResidentUsageRecord> => {
	const { sql } = db
	const [row] = await sql.begin(async tx => {
		await tx`
			insert into resident_installations (id) values (${record.installationId})
			on conflict (id) do nothing`
		return tx<UsageRow[]>`
			insert into resident_usage (
				installation_id, day, month, repository, total_tokens, list_price_usd, billable_usd,
				tasks_started, tasks_succeeded, tasks_failed, pull_requests_opened, record, generated_at
			)
			values (
				${record.installationId}, ${record.day}, ${record.month}, ${record.repository},
				${record.totalTokens}, ${record.cost.listPriceUsd}, ${record.cost.billableUsd},
				${record.tasks.started}, ${record.tasks.succeeded}, ${record.tasks.failed},
				${record.tasks.pullRequestsOpened}, ${tx.json(record as never)},
				${new Date(record.generatedAt)}
			)
			on conflict (installation_id, day) do update set
				month = excluded.month,
				repository = excluded.repository,
				total_tokens = excluded.total_tokens,
				list_price_usd = excluded.list_price_usd,
				billable_usd = excluded.billable_usd,
				tasks_started = excluded.tasks_started,
				tasks_succeeded = excluded.tasks_succeeded,
				tasks_failed = excluded.tasks_failed,
				pull_requests_opened = excluded.pull_requests_opened,
				record = excluded.record,
				generated_at = excluded.generated_at,
				received_at = now()
			returning record`
	})
	return row!.record
}

export const listResidentUsage = async (
	db: Db,
	filter: ResidentUsageFilter = {}
): Promise<ResidentUsageRecord[]> => {
	const { sql } = db
	const rows = await sql<UsageRow[]>`
		select record from resident_usage
		where true
			${filter.installationId === undefined ? sql`` : sql`and installation_id = ${filter.installationId}`}
			${filter.month === undefined ? sql`` : sql`and month = ${filter.month}`}
		order by day desc
		limit 1000`
	return rows.map(row => row.record)
}

/** One row per installation and month; the cap view is taken from the month's latest day */
export const summarizeResidentUsage = async (
	db: Db,
	filter: ResidentUsageFilter = {}
): Promise<ResidentUsageSummary[]> => {
	const { sql } = db
	const rows = await sql<SummaryRow[]>`
		select
			u.installation_id,
			i.org_id,
			u.month,
			(array_agg(u.repository order by u.day desc))[1] as repository,
			count(*) as days,
			sum(u.total_tokens) as total_tokens,
			sum(u.list_price_usd) as list_price_usd,
			sum(u.billable_usd) as billable_usd,
			sum(u.tasks_started) as tasks_started,
			sum(u.tasks_succeeded) as tasks_succeeded,
			sum(u.tasks_failed) as tasks_failed,
			sum(u.pull_requests_opened) as pull_requests_opened,
			(array_agg((u.record -> 'monthlyCap' ->> 'tokens')::bigint order by u.day desc))[1] as cap_tokens,
			(array_agg((u.record -> 'monthlyCap' ->> 'usedTokens')::bigint order by u.day desc))[1] as cap_used_tokens
		from resident_usage u
		join resident_installations i on i.id = u.installation_id
		where true
			${filter.installationId === undefined ? sql`` : sql`and u.installation_id = ${filter.installationId}`}
			${filter.month === undefined ? sql`` : sql`and u.month = ${filter.month}`}
		group by u.installation_id, i.org_id, u.month
		order by u.month desc, u.installation_id asc
		limit 500`
	return rows.map(toResidentUsageSummary)
}

// MARK: Usage reports

export const getResidentUsageReport = async (
	db: Db,
	installationId: string,
	month: string
): Promise<ResidentUsageReport | undefined> => {
	const [row] = await db.sql<ReportRow[]>`
		select * from resident_usage_reports
		where installation_id = ${installationId} and month = ${month}`
	return row && toResidentUsageReport(row)
}

export const listResidentUsageReports = async (
	db: Db,
	month?: string
): Promise<ResidentUsageReport[]> => {
	const { sql } = db
	const rows = await sql<ReportRow[]>`
		select * from resident_usage_reports
		where true ${month === undefined ? sql`` : sql`and month = ${month}`}
		order by month desc, installation_id asc
		limit 500`
	return rows.map(toResidentUsageReport)
}

export const upsertResidentUsageReport = async (
	db: Db,
	report: NewResidentUsageReport
): Promise<ResidentUsageReport> => {
	const [row] = await db.sql<ReportRow[]>`
		insert into resident_usage_reports (installation_id, month, usd_cents, provider, reference)
		values (
			${report.installationId}, ${report.month}, ${report.usdCents}, ${report.provider},
			${report.reference ?? null}
		)
		on conflict (installation_id, month) do update set
			usd_cents = excluded.usd_cents,
			provider = excluded.provider,
			reference = excluded.reference,
			reported_at = now()
		returning *`
	return toResidentUsageReport(row!)
}

export const createResidentRepository = (db: Db): ResidentRepository => ({
	getInstallation: id => getResidentInstallation(db, id),
	listInstallations: () => listResidentInstallations(db),
	upsertInstallation: upsert => upsertResidentInstallation(db, upsert),
	upsertUsage: record => upsertResidentUsage(db, record),
	listUsage: filter => listResidentUsage(db, filter),
	summarizeUsage: filter => summarizeResidentUsage(db, filter),
	getUsageReport: (installationId, month) => getResidentUsageReport(db, installationId, month),
	listUsageReports: month => listResidentUsageReports(db, month),
	upsertUsageReport: report => upsertResidentUsageReport(db, report),
})
