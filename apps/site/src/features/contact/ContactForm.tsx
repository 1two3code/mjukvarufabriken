import styles from './ContactForm.module.css'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { isApiError } from '#/app/api.ts'
import { useSendContactMessageMutation } from '#/features/contact/contactApiSlice.ts'

import { Button } from '#/components/Button.tsx'
import { Input } from '#/components/Input.tsx'

import type { ContactMessage } from '#/features/contact/contactApiSlice.ts'

type FormData = Required<ContactMessage>
type Errors = Partial<Record<keyof FormData, string>>

const emptyForm: FormData = { name: '', email: '', company: '', message: '' }
const minMessageLength = 10

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

export function ContactForm() {
	const { t } = useTranslation()
	const [formData, setFormData] = useState(emptyForm)
	const [errors, setErrors] = useState<Errors>({})
	const [sendMessage, { isLoading, isSuccess, isError, error }] = useSendContactMessageMutation()

	const validate = (data: FormData): Errors => {
		const result: Errors = {}
		if (!data.name.trim()) result.name = t('contact.error.required')
		if (!isEmail(data.email.trim())) result.email = t('contact.error.email')
		if (data.message.trim().length < minMessageLength) {
			result.message = t('contact.error.messageTooShort', { min: minMessageLength })
		}
		return result
	}

	const handleChange = (value: string, name: string) =>
		setFormData(current => ({ ...current, [name]: value }))

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		const validation = validate(formData)
		setErrors(validation)
		if (Object.keys(validation).length) return

		const company = formData.company.trim()
		await sendMessage({
			name: formData.name.trim(),
			email: formData.email.trim(),
			message: formData.message.trim(),
			...(company && { company }),
		})
	}

	if (isSuccess) {
		return (
			<div className={styles.success} role="status">
				<h3>{t('contact.success.title')}</h3>
				<p>{t('contact.success.body')}</p>
			</div>
		)
	}

	const errorKey =
		isApiError(error) && error.code === 'contactRateLimited'
			? 'contact.error.rateLimited'
			: 'contact.error.failed'

	return (
		<form className={styles.form} onSubmit={handleSubmit} noValidate>
			<div className={styles.row}>
				<Input
					label={t('contact.field.name')}
					name="name"
					value={formData.name}
					error={errors.name}
					required
					onChange={handleChange}
				/>
				<Input
					label={t('contact.field.email')}
					name="email"
					type="email"
					value={formData.email}
					error={errors.email}
					required
					onChange={handleChange}
				/>
			</div>
			<Input
				label={t('contact.field.company')}
				name="company"
				value={formData.company}
				onChange={handleChange}
			/>
			<Input
				label={t('contact.field.message')}
				name="message"
				value={formData.message}
				error={errors.message}
				required
				multiline
				onChange={handleChange}
			/>
			{isError && (
				<p className={styles.error} role="alert">
					{t(errorKey)}
				</p>
			)}
			<div className={styles.actions}>
				<Button type="submit" disabled={isLoading}>
					{isLoading ? t('contact.action.sending') : t('contact.action.send')}
				</Button>
				<span className={styles.hint}>{t('contact.hint.required')}</span>
			</div>
		</form>
	)
}
