import styles from './HostingPanel.module.css'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { usePermission } from '#/hooks/usePermission.ts'
import { useSetHostingUntilMutation } from '#/features/admin/adminApiSlice.ts'
import {
	fromDateInputValue,
	hostingWindowState,
	toDateInputValue,
} from '#/features/orders/hosting.ts'
import { useGetOrderExportQuery } from '#/features/orders/ordersApiSlice.ts'

import { Button } from '#/components/Button.tsx'

import type { Order } from '@mf/models'

const formatSize = (bytes: number) =>
	bytes < 1024
		? `${bytes} B`
		: bytes < 1024 ** 2
			? `${Math.round(bytes / 1024)} kB`
			: `${(bytes / 1024 ** 2).toFixed(1)} MB`

type HostingPanelProps = {
	order: Order
}

/**
 * The single-use hosting window (wave 14, strategy F4): "hosted until <date> (N days left)", the
 * final export's download list once one exists (repo zip, database dump, storage copy and — after
 * the teardown — the deletion certificate), and an admin-only control to move or clear the
 * scheduled end. Hidden until the order has a window or is torn down, so an order still in its
 * spec/build phase shows nothing here.
 */
export function HostingPanel({ order }: HostingPanelProps) {
	const { t, i18n } = useTranslation()
	const { hasPermission } = usePermission()
	const admin = hasPermission('job:admin')
	const state = hostingWindowState(order.hostingUntil, order.lifecycle)
	// An export exists once the window ended (the sweep exports first) or the order is torn down
	const exportExpected = state.kind === 'ended' || state.kind === 'tornDown'
	const { data: exported, isError } = useGetOrderExportQuery(order.id, { skip: !exportExpected })
	const [setHostingUntil, { isLoading: isSaving }] = useSetHostingUntilMutation()
	const [date, setDate] = useState(() =>
		toDateInputValue(state.kind === 'none' ? undefined : state.until)
	)

	if (state.kind === 'none' && !admin) return null
	if (state.kind === 'none' && order.status !== 'delivered' && order.status !== 'paid') return null

	const formatDate = (value: Date) => value.toLocaleDateString(i18n.language)
	const save = () => {
		const hostingUntil = fromDateInputValue(date)
		if (hostingUntil) void setHostingUntil({ orderId: order.id, hostingUntil })
	}

	return (
		<section className={styles.panel} aria-label={t('order.hosting.title')}>
			<h2 className={styles.title}>{t('order.hosting.title')}</h2>
			{state.kind === 'open' && (
				<>
					<p className={styles.status}>
						{t('order.hosting.until', { date: formatDate(state.until) })}{' '}
						<span className={styles.countdown}>
							{t('order.hosting.daysLeft', { count: state.daysLeft })}
						</span>
					</p>
					<p className={styles.intro}>{t('order.hosting.intro')}</p>
				</>
			)}
			{state.kind === 'ended' && (
				<p className={styles.status}>
					{t('order.hosting.ended', { date: formatDate(state.until) })}
				</p>
			)}
			{state.kind === 'tornDown' && <p className={styles.status}>{t('order.hosting.tornDown')}</p>}
			{state.kind === 'none' && <p className={styles.intro}>{t('order.hosting.noEnd')}</p>}

			{exportExpected && (
				<div className={styles.export}>
					<h3 className={styles.subtitle}>{t('order.hosting.export.title')}</h3>
					{(isError || !exported) && (
						<p className={styles.empty}>{t('order.hosting.export.none')}</p>
					)}
					{exported?.status === 'pending' && (
						<p className={styles.empty}>{t('order.hosting.export.pending')}</p>
					)}
					{exported?.status === 'failed' && (
						<p className={styles.empty}>{t('order.hosting.export.failed')}</p>
					)}
					{!!exported?.files.length && (
						<ul className={styles.list}>
							{exported.files.map(file => (
								<li key={file.key}>
									<a href={file.url} target="_blank" rel="noreferrer">
										{file.name}
									</a>
									<span className={styles.description}> — {formatSize(file.size)}</span>
								</li>
							))}
						</ul>
					)}
				</div>
			)}

			{admin && state.kind !== 'tornDown' && (
				<div className={styles.admin}>
					<label className={styles.field}>
						<span className={styles.label}>{t('order.hosting.admin.label')}</span>
						<input
							className={styles.date}
							type="date"
							value={date}
							onChange={event => setDate(event.target.value)}
						/>
					</label>
					<div className={styles.actions}>
						<Button size="small" disabled={isSaving || !fromDateInputValue(date)} onClick={save}>
							{t('order.hosting.admin.save')}
						</Button>
						{state.kind !== 'none' && (
							<Button
								size="small"
								color="secondary"
								disabled={isSaving}
								onClick={() => void setHostingUntil({ orderId: order.id, hostingUntil: null })}
							>
								{t('order.hosting.admin.clear')}
							</Button>
						)}
					</div>
				</div>
			)}
		</section>
	)
}
