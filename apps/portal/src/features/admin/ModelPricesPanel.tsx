import styles from './ModelPricesPanel.module.css'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useToast } from '#/hooks/useToast.ts'
import {
	useAddModelPriceMutation,
	useGetModelPricesQuery,
} from '#/features/admin/adminApiSlice.ts'

import { Button } from '#/components/Button.tsx'
import { Table } from '#/components/table/Table.tsx'

import type { ModelPriceRow } from '@mf/models'
import type { TableColumn } from '#/components/table/Table.tsx'

const rateFields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const
type RateField = (typeof rateFields)[number]

const emptyForm = { modelPrefix: '', input: '', output: '', cacheRead: '', cacheWrite: '' }

/** `datetime-local` value → ISO; empty → undefined (the api defaults to now) */
const toIso = (local: string) => (local ? new Date(local).toISOString() : undefined)

/**
 * The append-only model price table (USD / MTok) with a form to add a row. A row takes effect
 * for orders created from its `effectiveFrom` on; nothing is edited or deleted.
 */
export function ModelPricesPanel() {
	const { t, i18n } = useTranslation()
	const toast = useToast()
	const { data: rows = [], isLoading, isError } = useGetModelPricesQuery()
	const [add, { isLoading: isAdding }] = useAddModelPriceMutation()
	const [form, setForm] = useState(emptyForm)
	const [effectiveFrom, setEffectiveFrom] = useState('')

	const rates = Object.fromEntries(
		rateFields.map(field => [field, Number(form[field])])
	) as Record<RateField, number>
	const valid =
		form.modelPrefix.trim().length > 0 &&
		rateFields.every(field => form[field].trim() !== '' && rates[field] >= 0)

	const handleAdd = async (event: React.FormEvent) => {
		event.preventDefault()
		const result = await add({
			modelPrefix: form.modelPrefix.trim(),
			...rates,
			effectiveFrom: toIso(effectiveFrom),
		})
		if (!result.error) {
			toast('success', t('prices.toast.added'))
			setForm(emptyForm)
			setEffectiveFrom('')
		}
	}

	const rate = (value: number) =>
		value.toLocaleString(i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 4 })

	const columns: TableColumn<ModelPriceRow>[] = [
		{ header: t('prices.field.prefix'), field: 'modelPrefix', sortable: true },
		...rateFields.map(
			(field): TableColumn<ModelPriceRow> => ({
				header: t(`prices.field.${field}`),
				field,
				alignment: 'right',
				cell: row => rate(row[field]),
			})
		),
		{
			header: t('prices.field.effectiveFrom'),
			field: 'effectiveFrom',
			sortable: true,
			cell: row => new Date(row.effectiveFrom).toLocaleString(i18n.language),
		},
		{
			header: t('prices.field.created'),
			field: 'createdAt',
			sortable: true,
			cell: row => new Date(row.createdAt).toLocaleString(i18n.language),
		},
	]

	return (
		<>
			<form className={styles.form} onSubmit={handleAdd}>
				<label className={styles.field}>
					<span className={styles.label}>{t('prices.field.prefix')}</span>
					<input
						className={`${styles.input} ${styles.prefix}`}
						placeholder="claude-sonnet"
						value={form.modelPrefix}
						onChange={event => setForm({ ...form, modelPrefix: event.target.value })}
					/>
				</label>
				{rateFields.map(field => (
					<label key={field} className={styles.field}>
						<span className={styles.label}>{t(`prices.field.${field}`)}</span>
						<input
							className={styles.input}
							type="number"
							min={0}
							step="any"
							inputMode="decimal"
							value={form[field]}
							onChange={event => setForm({ ...form, [field]: event.target.value })}
						/>
					</label>
				))}
				<label className={styles.field}>
					<span className={styles.label}>{t('prices.field.effectiveFrom')}</span>
					<input
						className={styles.input}
						type="datetime-local"
						value={effectiveFrom}
						onChange={event => setEffectiveFrom(event.target.value)}
					/>
				</label>
				<Button type="submit" size="tiny" color="secondary" disabled={!valid || isAdding}>
					{t('prices.action.add')}
				</Button>
			</form>
			<Table
				columns={columns}
				rows={rows}
				state={{ loading: isLoading, error: isError ? t('prices.loadError') : undefined }}
			/>
		</>
	)
}
