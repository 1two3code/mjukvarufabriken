import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'

import { useAppDispatch, useAppSelector } from '#/app/hooks.ts'
import { selectToken, setTokens } from '#/features/session/sessionSlice.ts'

import { Button } from '#/components/Button.tsx'
import { Input } from '#/components/Input.tsx'

export function LoginPage() {
	const { t } = useTranslation()
	const dispatch = useAppDispatch()
	const token = useAppSelector(selectToken)
	const [value, setValue] = useState('')

	if (token) return <Navigate to="/" replace />

	const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		dispatch(setTokens({ token: value.trim(), refreshToken: '' }))
	}

	return (
		<form onSubmit={handleSubmit}>
			<h1>{t('page.login.title')}</h1>
			<p>{t('page.login.body')}</p>
			<Input label={t('page.login.field.token')} name="token" value={value} onChange={setValue} />
			<Button type="submit" disabled={!value.trim()}>
				{t('page.login.action.signIn')}
			</Button>
		</form>
	)
}
