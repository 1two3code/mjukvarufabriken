import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate } from 'react-router-dom'

import { useAppSelector } from '#/app/hooks.ts'
import { useRequestMagicLinkMutation } from '#/features/auth/authApiSlice.ts'
import { selectToken } from '#/features/session/sessionSlice.ts'

import { Button } from '#/components/Button.tsx'
import { Input } from '#/components/Input.tsx'

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

/** "Sign in with GitHub" is offered once the OAuth App exists (`VITE_GITHUB_SIGNIN=1`) */
const githubSignInEnabled = import.meta.env.VITE_GITHUB_SIGNIN === '1'
/** A full navigation (not a fetch): the api sets the OAuth state cookie and redirects to GitHub */
const githubSignInUrl = `${import.meta.env.VITE_API_URL}/auth/github`

export function LoginPage() {
	const { t } = useTranslation()
	const token = useAppSelector(selectToken)
	const [email, setEmail] = useState('')
	const [sentTo, setSentTo] = useState<string | null>(null)
	const [requestMagicLink, { isLoading, isError }] = useRequestMagicLinkMutation()

	if (token) return <Navigate to="/" replace />

	const trimmed = email.trim()

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		const result = await requestMagicLink({ email: trimmed })
		if (!result.error) setSentTo(trimmed)
	}

	if (sentTo) {
		return (
			<>
				<h1>{t('page.login.sent.title')}</h1>
				<p>{t('page.login.sent.body', { email: sentTo })}</p>
				<p>{t('page.login.sent.hint')}</p>
				<Button color="secondary" onClick={() => setSentTo(null)}>
					{t('page.login.sent.action.again')}
				</Button>
			</>
		)
	}

	return (
		<form onSubmit={handleSubmit}>
			<h1>{t('page.login.title')}</h1>
			<p>{t('page.login.body')}</p>
			<Input
				label={t('page.login.field.email')}
				name="email"
				value={email}
				onChange={setEmail}
				disabled={isLoading}
				error={isError ? t('page.login.error.failed') : undefined}
			/>
			<Button type="submit" disabled={!isEmail(trimmed) || isLoading}>
				{t('page.login.action.sendLink')}
			</Button>
			{githubSignInEnabled && (
				<p>
					{t('page.login.divider')} <a href={githubSignInUrl}>{t('page.login.action.github')}</a>
				</p>
			)}
		</form>
	)
}
