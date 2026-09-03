import styles from './NewOrderForm.module.css'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { orderKind } from '@mf/models'

import { useToast } from '#/hooks/useToast.ts'
import { useCreateOrderMutation } from '#/features/orders/ordersApiSlice.ts'

import { Button } from '#/components/Button.tsx'
import { Input } from '#/components/Input.tsx'

import type { OrderKind } from '@mf/models'

/**
 * "New order": a name and the pricing-ladder rung — a ~500 kr voucher demo (admin-approved, a
 * few per week) or a real build — is all that is needed; the spec chat fills in the rest.
 */
export function NewOrderForm() {
	const { t } = useTranslation()
	const toast = useToast()
	const navigate = useNavigate()
	const [name, setName] = useState('')
	const [kind, setKind] = useState<OrderKind>('demo')
	const [createOrder, { isLoading }] = useCreateOrderMutation()

	const trimmed = name.trim()

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!trimmed) return
		const result = await createOrder({ name: trimmed, kind })
		if (result.error) return
		toast('success', t('order.toast.created'))
		navigate(`/orders/${result.data.id}/spec`)
	}

	return (
		<form className={styles.form} onSubmit={handleSubmit}>
			<fieldset className={styles.kinds} disabled={isLoading}>
				<legend className={styles.legend}>{t('order.field.kind')}</legend>
				{orderKind.map(option => (
					<label
						key={option}
						className={[styles.kind, kind === option ? styles.selected : ''].join(' ')}
					>
						<input
							className={styles.radio}
							type="radio"
							name="kind"
							value={option}
							checked={kind === option}
							onChange={() => setKind(option)}
						/>
						<span className={styles.kindTitle}>{t(`order.kindOption.${option}.title`)}</span>
						<span className={styles.kindHint}>{t(`order.kindOption.${option}.hint`)}</span>
					</label>
				))}
			</fieldset>
			<div className={styles.row}>
				<Input
					className={styles.name}
					label={t('order.field.name')}
					name="name"
					value={name}
					disabled={isLoading}
					onChange={setName}
				/>
				<Button type="submit" disabled={!trimmed || isLoading}>
					{t('order.action.create')}
				</Button>
			</div>
		</form>
	)
}
