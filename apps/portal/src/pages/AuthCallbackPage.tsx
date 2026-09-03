import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useSearchParams } from 'react-router-dom'

import { isApiError } from '#/app/api.ts'
import { useAppDispatch } from '#/app/hooks.ts'
import { useEffectOnce } from '#/hooks/useEffectOnce.ts'
import { useVerifyMagicLinkMutation } from '#/features/auth/authApiSlice.ts'
import { safeRedirect, takePostLoginRedirect } from '#/features/auth/postLoginRedirect.ts'
import { setTokens } from '#/features/session/sessionSlice.ts'

import { Spinner } from '#/components/Spinner.tsx'

/**
 * Landing page of the magic link (`/auth/callback?token=…`): exchanges the single-use token
 * for a token pair, stores it and redirects into the portal — to `?redirect=` when the link
 * carries one, else to the path the login page remembered (the site's quote claim), else `/`.
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
	const [redirect, setRedirect] = useState('/')

	useEffectOnce(() => {
		if (!token || started.current) return
		started.current = true
		verifyMagicLink({ token }).then(result => {
			if (result.error) return
			dispatch(setTokens(result.data))
			// Read (and clear) the remembered path only once the sign-in has actually succeeded
			setRedirect(safeRedirect(searchParams.get('redirect') ?? takePostLoginRedirect()))
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
