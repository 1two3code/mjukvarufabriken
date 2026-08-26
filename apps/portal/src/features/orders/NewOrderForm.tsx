import styles from './NewOrderForm.module.css'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { useToast } from '#/hooks/useToast.ts'
import { useCreateOrderMutation } from '#/features/orders/ordersApiSlice.ts'

import { Button } from '#/components/Button.tsx'
import { Input } from '#/components/Input.tsx'

/** "New order": a name is all that is needed — the spec chat fills in the rest */
export function NewOrderForm() {
	const { t } = useTranslation()
	const toast = useToast()
	const navigate = useNavigate()
	const [name, setName] = useState('')
	const [createOrder, { isLoading }] = useCreateOrderMutation()

	const trimmed = name.trim()

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!trimmed) return
		const result = await createOrder({ name: trimmed })
		if (result.error) return
		toast('success', t('order.toast.created'))
		navigate(`/orders/${result.data.id}/spec`)
	}

	return (
		<form className={styles.form} onSubmit={handleSubmit}>
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
		</form>
	)
}
