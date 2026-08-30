import styles from './ItemForm.module.css'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useToast } from '#/hooks/useToast.ts'
import { useCreateItemMutation } from '#/features/items/itemsApiSlice.ts'

import { Button } from '#/components/Button.tsx'
import { Input } from '#/components/Input.tsx'

import type { ItemMutation } from '@template/models'

const emptyForm: ItemMutation['CreateItem'] = { name: '', description: '' }

export function ItemForm() {
	const { t } = useTranslation()
	const toast = useToast()
	const [createItem, { isLoading }] = useCreateItemMutation()
	const [form, setForm] = useState(emptyForm)

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		const result = await createItem({ ...form, description: form.description || undefined })
		if (result.error) return

		toast('success', t('item.toast.created'))
		setForm(emptyForm)
	}

	return (
		<form className={styles.form} onSubmit={handleSubmit}>
			<Input
				label={t('item.field.name')}
				name="name"
				value={form.name}
				onChange={name => setForm({ ...form, name })}
			/>
			<Input
				label={t('item.field.description')}
				name="description"
				value={form.description ?? ''}
				onChange={description => setForm({ ...form, description })}
			/>
			<Button type="submit" size="small" disabled={!form.name || isLoading}>
				{t('item.action.create')}
			</Button>
		</form>
	)
}
