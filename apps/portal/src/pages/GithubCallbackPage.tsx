import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'

import { useEffectOnce } from '#/hooks/useEffectOnce.ts'

import { Spinner } from '#/components/Spinner.tsx'

/** Error codes the api's `/bff/auth/github/callback` redirects back with */
const knownErrors = ['state', 'expired', 'denied', 'email', 'failed'] as const
type KnownError = (typeof knownErrors)[number]

const toKnownError = (value: string | null): KnownError =>
	(knownErrors as readonly string[]).includes(value ?? '') ? (value as KnownError) : 'failed'

/** GitHub's own error codes (`access_denied`, …) are forwarded; the api's are shown here */
const isApiError = (value: string | null) => (knownErrors as readonly string[]).includes(value ?? '')

/**
 * GitHub's redirect target (`/auth/github/callback?code=…&state=…`, the OAuth App's callback
 * url): forwards the browser to the api callback as a full navigation so the httpOnly state
 * cookie travels along — GitHub's own `?error=…` (the user cancelled) included, so the api
 * clears its state cookie, logs and maps the code. The api answers with a one-shot link to
 * `/auth/callback`, which finishes the sign-in exactly like a magic link, or redirects back
 * here with one of its own `?error=` codes, which the page explains with a link to the login
 * page.
 */
export function GithubCallbackPage() {
	const { t } = useTranslation()
	const [searchParams] = useSearchParams()

	const code = searchParams.get('code')
	const state = searchParams.get('state')
	const error = searchParams.get('error')
	const forward = error ? !isApiError(error) : Boolean(code && state)

	useEffectOnce(() => {
		if (!forward) return
		const url = new URL(`${import.meta.env.VITE_API_URL}/auth/github/callback`, location.origin)
		for (const [name, value] of [
			['error', error],
			['code', code],
			['state', state],
		] as const) {
			if (value) url.searchParams.set(name, value)
		}
		location.replace(url.toString())
	})

	if (forward) {
		return (
			<>
				<h1>{t('page.authCallback.title')}</h1>
				<Spinner center />
			</>
		)
	}

	return (
		<>
			<h1>{t('page.authCallback.error.title')}</h1>
			<p>{t(`page.githubCallback.error.${toKnownError(error)}`)}</p>
			<p>
				<Link to="/login">{t('page.githubCallback.action.backToLogin')}</Link>
			</p>
		</>
	)
}
