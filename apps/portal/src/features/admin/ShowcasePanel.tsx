import styles from './ShowcasePanel.module.css'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useToast } from '#/hooks/useToast.ts'
import { useGetAdminOrdersQuery } from '#/features/admin/adminApiSlice.ts'
import {
	useGetAdminShowcasesQuery,
	useUpsertShowcaseMutation,
} from '#/features/admin/showcaseApiSlice.ts'

import { Button } from '#/components/Button.tsx'
import { Spinner } from '#/components/Spinner.tsx'

import type { Order, Showcase } from '@mf/models'

/** Orders whose build has been delivered — the only ones with a live app to show */
const showcaseableStatus: readonly Order['status'][] = ['delivered', 'paid']
export const isShowcaseable = (order: Order) => showcaseableStatus.includes(order.status)

type FormState = {
	published: boolean
	title: string
	blurbSv: string
	blurbEn: string
	url: string
	sort: string
}

/** The stored row, or a fresh draft named after the order */
const initialForm = (order: Order, showcase?: Showcase): FormState => ({
	published: showcase?.published ?? false,
	title: showcase?.title ?? order.name,
	blurbSv: showcase?.blurbSv ?? '',
	blurbEn: showcase?.blurbEn ?? '',
	url: showcase?.url ?? '',
	sort: String(showcase?.sort ?? 0),
})

type ShowcaseFormProps = {
	order: Order
	showcase?: Showcase
}

/**
 * One order's showcase row, edited in place. An empty URL lets the api resolve the order's live
 * URL from its latest delivery; publishing without any is refused (`showcaseNoLiveUrl` toast).
 */
function ShowcaseForm({ order, showcase }: ShowcaseFormProps) {
	const { t } = useTranslation()
	const toast = useToast()
	const [upsert, { isLoading }] = useUpsertShowcaseMutation()
	const [form, setForm] = useState(() => initialForm(order, showcase))

	const dirty = JSON.stringify(form) !== JSON.stringify(initialForm(order, showcase))
	const sort = Number(form.sort)
	const valid = form.title.trim().length > 0 && Number.isInteger(sort)
	const update = (patch: Partial<FormState>) => setForm({ ...form, ...patch })

	const handleSave = async (event: React.FormEvent) => {
		event.preventDefault()
		const url = form.url.trim()
		const result = await upsert({
			orderId: order.id,
			published: form.published,
			title: form.title.trim(),
			blurbSv: form.blurbSv.trim(),
			blurbEn: form.blurbEn.trim(),
			sort,
			...(url && { url }),
		})
		if (!result.error) toast('success', t('showcase.toast.saved'))
	}

	return (
		<form className={styles.form} onSubmit={handleSave}>
			<header className={styles.header}>
				<span className={styles.name}>{order.name}</span>
				<span className={styles.status}>{t(`order.status.${order.status}`)}</span>
				<span className={showcase?.published ? styles.published : styles.draft}>
					{t(showcase?.published ? 'showcase.status.published' : 'showcase.status.draft')}
				</span>
			</header>
			<div className={styles.fields}>
				<label className={styles.field}>
					<span className={styles.label}>{t('showcase.field.title')}</span>
					<input
						className={styles.input}
						value={form.title}
						maxLength={120}
						onChange={event => update({ title: event.target.value })}
					/>
				</label>
				<label className={styles.field}>
					<span className={styles.label}>{t('showcase.field.url')}</span>
					<input
						className={styles.input}
						type="url"
						placeholder={t('showcase.hint.url')}
						value={form.url}
						onChange={event => update({ url: event.target.value })}
					/>
				</label>
				<label className={styles.field}>
					<span className={styles.label}>{t('showcase.field.blurbSv')}</span>
					<textarea
						className={styles.textarea}
						rows={3}
						maxLength={600}
						value={form.blurbSv}
						onChange={event => update({ blurbSv: event.target.value })}
					/>
				</label>
				<label className={styles.field}>
					<span className={styles.label}>{t('showcase.field.blurbEn')}</span>
					<textarea
						className={styles.textarea}
						rows={3}
						maxLength={600}
						value={form.blurbEn}
						onChange={event => update({ blurbEn: event.target.value })}
					/>
				</label>
			</div>
			<div className={styles.actions}>
				<label className={styles.checkbox}>
					<input
						type="checkbox"
						checked={form.published}
						onChange={event => update({ published: event.target.checked })}
					/>
					<span>{t('showcase.field.published')}</span>
				</label>
				<label className={styles.sort}>
					<span className={styles.label}>{t('showcase.field.sort')}</span>
					<input
						className={styles.input}
						type="number"
						step={1}
						min={-1000}
						max={1000}
						value={form.sort}
						onChange={event => update({ sort: event.target.value })}
					/>
				</label>
				<Button
					type="submit"
					size="tiny"
					color="secondary"
					disabled={!dirty || !valid || isLoading}
				>
					{t('showcase.action.save')}
				</Button>
			</div>
		</form>
	)
}

/** Every delivered order with its showcase form (wave 14, F3: the demo gallery's admin side) */
export function ShowcasePanel() {
	const { t } = useTranslation()
	const orders = useGetAdminOrdersQuery()
	const showcases = useGetAdminShowcasesQuery()

	if (orders.isLoading || showcases.isLoading) return <Spinner center />
	if (orders.isError || showcases.isError) {
		return <p className={styles.state}>{t('showcase.loadError')}</p>
	}

	const delivered = (orders.data ?? []).filter(isShowcaseable)
	const byOrder = new Map((showcases.data ?? []).map(row => [row.orderId, row]))
	if (!delivered.length) return <p className={styles.state}>{t('showcase.empty')}</p>

	return (
		<ul className={styles.list}>
			{delivered.map(order => {
				const showcase = byOrder.get(order.id)
				return (
					<li key={order.id} className={styles.row}>
						{/* Re-key on the stored row so a save resets the form to what the api kept */}
						<ShowcaseForm key={showcase?.updatedAt ?? 'draft'} order={order} showcase={showcase} />
					</li>
				)
			})}
		</ul>
	)
}
