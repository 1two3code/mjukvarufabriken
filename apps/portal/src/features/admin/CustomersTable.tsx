import styles from './CustomersTable.module.css'

import { useTranslation } from 'react-i18next'

import { useToast } from '#/hooks/useToast.ts'
import { useGetAdminOrgsQuery, useProvisionAccountMutation } from '#/features/admin/adminApiSlice.ts'

import { Button } from '#/components/Button.tsx'
import { Table } from '#/components/table/Table.tsx'

import type { Org } from '@mf/models'
import type { TableColumn } from '#/components/table/Table.tsx'

/**
 * Every customer org and its vended AWS account, if any (org-accounts.md). Accounts are normally
 * provisioned automatically once a deposit is paid (paymentService `startBuild`) — the button here
 * is the admin retry/override path for when that failed or needs re-triggering, not the primary flow.
 */
export function CustomersTable() {
	const { t, i18n } = useTranslation()
	const toast = useToast()
	const { data: orgs = [], isLoading, isError } = useGetAdminOrgsQuery()
	const [provision, { isLoading: isProvisioning }] = useProvisionAccountMutation()

	const handleProvision = async (org: Org) => {
		const result = await provision(org.id)
		if (result.error) return
		if (result.data.skipped) {
			toast('info', t('admin.customers.toast.skipped', { reason: result.data.reason ?? '' }))
		} else {
			toast('success', t('admin.customers.toast.provisioned', { accountId: result.data.accountId }))
		}
	}

	const columns: TableColumn<Org>[] = [
		{ header: t('admin.customers.field.org'), field: 'name', sortable: true },
		{
			header: t('admin.customers.field.account'),
			field: 'awsAccountId',
			cell: row =>
				row.awsAccountId ? (
					<span className={styles.account}>
						{row.awsAccountId}
						{row.awsAccountSlug && <span className={styles.slug}>mf-customer-{row.awsAccountSlug}</span>}
					</span>
				) : (
					<span className={styles.none}>{t('admin.customers.notProvisioned')}</span>
				),
		},
		{
			header: t('admin.field.created'),
			field: 'createdAt',
			sortable: true,
			cell: row => new Date(row.createdAt).toLocaleDateString(i18n.language),
		},
		{
			header: '',
			field: 'actions',
			alignment: 'right',
			cell: row =>
				!row.awsAccountId && (
					<Button
						size="tiny"
						color="secondary"
						disabled={isProvisioning}
						onClick={() => handleProvision(row)}
					>
						{t('admin.customers.action.provision')}
					</Button>
				),
		},
	]

	return (
		<Table
			columns={columns}
			rows={orgs}
			state={{ loading: isLoading, error: isError ? t('admin.customers.loadError') : undefined }}
		/>
	)
}
