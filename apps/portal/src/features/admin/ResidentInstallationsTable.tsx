import styles from './ResidentInstallationsTable.module.css'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useToast } from '#/hooks/useToast.ts'
import { useGetAdminOrgsQuery } from '#/features/admin/adminApiSlice.ts'
import { useUpsertResidentInstallationMutation } from '#/features/admin/residentApiSlice.ts'

import { Button } from '#/components/Button.tsx'
import { Table } from '#/components/table/Table.tsx'

import type { ResidentInstallation } from '@mf/models'
import type { TableColumn } from '#/components/table/Table.tsx'

type ResidentInstallationsTableProps = {
	installations: ResidentInstallation[]
	isLoading: boolean
	isError: boolean
}

type LinkFormProps = {
	installation: ResidentInstallation
}

/** Inline form: which org the installation belongs to and the Stripe customer its usage bills to */
function LinkForm({ installation }: LinkFormProps) {
	const { t } = useTranslation()
	const toast = useToast()
	const { data: orgs = [] } = useGetAdminOrgsQuery()
	const [upsert, { isLoading }] = useUpsertResidentInstallationMutation()
	const [orgId, setOrgId] = useState(installation.orgId ?? '')
	const [billingCustomerId, setBillingCustomerId] = useState(installation.billingCustomerId ?? '')

	const dirty =
		orgId !== (installation.orgId ?? '') ||
		billingCustomerId !== (installation.billingCustomerId ?? '')

	const handleSave = async (event: React.FormEvent) => {
		event.preventDefault()
		const result = await upsert({
			id: installation.id,
			orgId: orgId || null,
			billingCustomerId: billingCustomerId.trim() || null,
		})
		if (!result.error) toast('success', t('resident.toast.linked'))
	}

	return (
		<form className={styles.form} onSubmit={handleSave}>
			<select
				className={styles.select}
				aria-label={t('resident.field.org')}
				value={orgId}
				onChange={event => setOrgId(event.target.value)}
			>
				<option value="">{t('resident.unlinked')}</option>
				{orgs.map(org => (
					<option key={org.id} value={org.id}>
						{org.name}
					</option>
				))}
			</select>
			<input
				className={styles.input}
				aria-label={t('resident.field.billingCustomer')}
				placeholder="cus_…"
				value={billingCustomerId}
				onChange={event => setBillingCustomerId(event.target.value)}
			/>
			<Button size="tiny" color="secondary" disabled={!dirty || isLoading}>
				{t('resident.action.save')}
			</Button>
		</form>
	)
}

/** Every installation the api knows, with the org / billing customer link editable in place */
export function ResidentInstallationsTable({
	installations,
	isLoading,
	isError,
}: ResidentInstallationsTableProps) {
	const { t, i18n } = useTranslation()

	const columns: TableColumn<ResidentInstallation>[] = [
		{ header: t('resident.field.installation'), field: 'id', sortable: true },
		{
			header: t('resident.field.link'),
			field: 'link',
			cell: row => <LinkForm key={row.updatedAt} installation={row} />,
		},
		{
			header: t('resident.field.firstSeen'),
			field: 'createdAt',
			sortable: true,
			cell: row => new Date(row.createdAt).toLocaleDateString(i18n.language),
		},
	]

	return (
		<Table
			columns={columns}
			rows={installations}
			state={{ loading: isLoading, error: isError ? t('resident.loadError') : undefined }}
		/>
	)
}
