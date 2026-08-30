import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useSearchParams } from 'react-router-dom'

import { isApiError } from '#/app/api.ts'
import { useAppDispatch } from '#/app/hooks.ts'
import { useEffectOnce } from '#/hooks/useEffectOnce.ts'
import { useVerifyMagicLinkMutation } from '#/features/auth/authApiSlice.ts'
import { setTokens } from '#/features/session/sessionSlice.ts'

import { Spinner } from '#/components/Spinner.tsx'

/** Only same-origin paths are honoured as post-login redirects */
const safeRedirect = (value: string | null) =>
	value && value.startsWith('/') && !value.startsWith('//') ? value : '/'

/**
 * Landing page of the magic link (`/auth/callback?token=…`): exchanges the single-use token
 * for a token pair, stores it and redirects into the portal.
 */
export function AuthCallbackPage() {
	const { t } = useTranslation()
	const dispatch = useAppDispatch()
	const [searchParams] = useSearchParams()
	const [verifyMagicLink, { error }] = useVerifyMagicLinkMutation()
	const [done, setDone] = useState(false)
	// The token is single use — never verify twice (React strict mode runs effects twice)
	const started = useRef(false)

	const token = searchParams.get('token')
	const redirect = safeRedirect(searchParams.get('redirect'))

	useEffectOnce(() => {
		if (!token || started.current) return
		started.current = true
		verifyMagicLink({ token }).then(result => {
			if (result.error) return
			dispatch(setTokens(result.data))
			setDone(true)
		})
	})

	if (done) return <Navigate to={redirect} replace />

	if (!token || error) {
		const code = isApiError(error) ? error.code : undefined
		return (
			<>
				<h1>{t('page.authCallback.error.title')}</h1>
				<p>
					{code === 'invalidMagicLink' || !token
						? t('page.authCallback.error.invalidLink')
						: t('page.authCallback.error.failed')}
				</p>
				<p>
					<Link to="/login">{t('page.authCallback.action.backToLogin')}</Link>
				</p>
			</>
		)
	}

	return (
		<>
			<h1>{t('page.authCallback.title')}</h1>
			<Spinner center />
		</>
	)
}
