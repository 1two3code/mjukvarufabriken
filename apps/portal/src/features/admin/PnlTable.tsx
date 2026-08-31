import styles from './PnlTable.module.css'

import { useTranslation } from 'react-i18next'

import { formatSek } from '#/features/admin/margin.ts'

import { Table } from '#/components/table/Table.tsx'

import type { PnlMonthRow } from '#/features/admin/margin.ts'
import type { TableColumn } from '#/components/table/Table.tsx'

type PnlTableProps = {
	rows: PnlMonthRow[]
	state?: { loading?: boolean; error?: string }
}

/**
 * Aggregate P&L per month, newest first: revenue (build fees + modeled subscriptions + resident
 * billing) against cost (`jobs.cost_usd` compute + resident list price + the shared-infra
 * estimate). Recognition is modeled — a shape-of-the-business view, not bookkeeping.
 */
export function PnlTable({ rows, state }: PnlTableProps) {
	const { t, i18n } = useTranslation()
	const sek = (value: number) => formatSek(value, i18n.language)

	const columns: TableColumn<PnlMonthRow>[] = [
		{ header: t('margin.pnl.month'), field: 'id', sortable: true },
		{
			header: t('margin.pnl.buildFees'),
			field: 'buildFeeSek',
			alignment: 'right',
			cell: row => sek(row.buildFeeSek),
		},
		{
			header: t('margin.pnl.subscriptions'),
			field: 'subscriptionSek',
			alignment: 'right',
			cell: row => sek(row.subscriptionSek),
		},
		{
			header: t('margin.pnl.resident'),
			field: 'residentRevenueSek',
			alignment: 'right',
			cell: row => sek(row.residentRevenueSek),
		},
		{
			header: t('margin.pnl.revenue'),
			field: 'revenueSek',
			alignment: 'right',
			cell: row => <strong>{sek(row.revenueSek)}</strong>,
		},
		{
			header: t('margin.pnl.buildCost'),
			field: 'buildCostSek',
			alignment: 'right',
			cell: row => sek(row.buildCostSek),
		},
		{
			header: t('margin.pnl.residentCost'),
			field: 'residentCostSek',
			alignment: 'right',
			cell: row => sek(row.residentCostSek),
		},
		{
			header: t('margin.pnl.infra'),
			field: 'infraSek',
			alignment: 'right',
			cell: row => sek(row.infraSek),
		},
		{
			header: t('margin.pnl.cost'),
			field: 'costSek',
			alignment: 'right',
			cell: row => <strong>{sek(row.costSek)}</strong>,
		},
		{
			header: t('margin.pnl.margin'),
			field: 'marginSek',
			alignment: 'right',
			sortable: true,
			cell: row => (
				<strong className={row.marginSek < 0 ? styles.negative : undefined}>
					{sek(row.marginSek)}
				</strong>
			),
		},
	]

	return <Table columns={columns} rows={rows.toReversed()} state={state} />
}
