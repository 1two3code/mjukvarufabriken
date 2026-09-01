import styles from './CustomerMarginTable.module.css'

import { useTranslation } from 'react-i18next'

import { formatSek } from '#/features/admin/margin.ts'

import { Table } from '#/components/table/Table.tsx'

import type { CustomerMarginRow } from '#/features/admin/margin.ts'
import type { TableColumn } from '#/components/table/Table.tsx'

type CustomerMarginTableProps = {
	rows: CustomerMarginRow[]
	state?: { loading?: boolean; error?: string }
}

/**
 * Margin per customer: real figures to date (build fees vs. `jobs.cost_usd` compute, resident
 * billed vs. list cost) and the modeled monthly run-rate (subscription vs. infra allocation).
 * Breakdowns sit in the cell tooltips to keep the table readable.
 */
export function CustomerMarginTable({ rows, state }: CustomerMarginTableProps) {
	const { t, i18n } = useTranslation()
	const sek = (value: number) => formatSek(value, i18n.language)

	const signClass = (value: number) => (value < 0 ? styles.negative : styles.positive)

	const columns: TableColumn<CustomerMarginRow>[] = [
		{ header: t('margin.customer.org'), field: 'orgName', sortable: true },
		{
			header: t('margin.customer.revenue'),
			field: 'revenueSek',
			alignment: 'right',
			sortable: true,
			cell: row => (
				<span
					title={t('margin.customer.revenueTitle', {
						buildFee: sek(row.buildFeeSek),
						resident: sek(row.residentRevenueSek),
					})}
				>
					{sek(row.revenueSek)}
				</span>
			),
		},
		{
			header: t('margin.customer.cost'),
			field: 'costSek',
			alignment: 'right',
			sortable: true,
			cell: row => (
				<span
					title={t('margin.customer.costTitle', {
						build: sek(row.buildCostSek),
						resident: sek(row.residentCostSek),
					})}
				>
					{sek(row.costSek)}
				</span>
			),
		},
		{
			header: t('margin.customer.margin'),
			field: 'marginSek',
			alignment: 'right',
			sortable: true,
			cell: row => <span className={signClass(row.marginSek)}>{sek(row.marginSek)}</span>,
		},
		{
			header: t('margin.customer.marginPct'),
			field: 'marginPct',
			alignment: 'right',
			sortable: true,
			cell: row =>
				row.marginPct === undefined ? (
					<span className={styles.none}>–</span>
				) : (
					<span className={signClass(row.marginPct)}>{row.marginPct} %</span>
				),
		},
		{
			header: t('margin.customer.subscription'),
			field: 'subscriptionSekPerMonth',
			alignment: 'right',
			sortable: true,
			cell: row => sek(row.subscriptionSekPerMonth),
		},
		{
			header: t('margin.customer.infra'),
			field: 'infraSekPerMonth',
			alignment: 'right',
			sortable: true,
			cell: row => sek(row.infraSekPerMonth),
		},
		{
			header: t('margin.customer.monthlyMargin'),
			field: 'monthlyMarginSek',
			alignment: 'right',
			sortable: true,
			cell: row => (
				<span className={signClass(row.monthlyMarginSek)}>{sek(row.monthlyMarginSek)}</span>
			),
		},
	]

	return <Table columns={columns} rows={rows} state={state} />
}
