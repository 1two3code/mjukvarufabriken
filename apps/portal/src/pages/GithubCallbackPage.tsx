import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'

import { useEffectOnce } from '#/hooks/useEffectOnce.ts'

import { Spinner } from '#/components/Spinner.tsx'

/** Error codes the api's `/bff/auth/github/callback` redirects back with */
const knownErrors = ['state', 'denied', 'email', 'failed'] as const
type KnownError = (typeof knownErrors)[number]

const toKnownError = (value: string | null): KnownError =>
	(knownErrors as readonly string[]).includes(value ?? '') ? (value as KnownError) : 'failed'

/**
 * GitHub's redirect target (`/auth/github/callback?code=…&state=…`, the OAuth App's callback
 * url): forwards the browser to the api callback as a full navigation so the httpOnly state
 * cookie travels along. The api answers with a one-shot link to `/auth/callback`, which
 * finishes the sign-in exactly like a magic link. On `?error=…` (from GitHub or the api) the
 * page explains and links back to the login page.
 */
export function GithubCallbackPage() {
	const { t } = useTranslation()
	const [searchParams] = useSearchParams()

	const code = searchParams.get('code')
	const state = searchParams.get('state')
	const error = searchParams.get('error')
	const forward = !error && code && state

	useEffectOnce(() => {
		if (!forward) return
		const url = new URL(`${import.meta.env.VITE_API_URL}/auth/github/callback`, location.origin)
		url.searchParams.set('code', code)
		url.searchParams.set('state', state)
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
