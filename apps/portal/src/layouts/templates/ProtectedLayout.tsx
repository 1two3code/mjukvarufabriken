import styles from './ProtectedLayout.module.css'

import { useTranslation } from 'react-i18next'
import { Navigate, Outlet } from 'react-router-dom'

import { isApiError } from '#/app/api.ts'
import { useAppSelector } from '#/app/hooks.ts'
import { useGetSessionQuery } from '#/features/session/sessionApiSlice.ts'
import { selectToken } from '#/features/session/sessionSlice.ts'

import { Header } from '#/layouts/header/Header.tsx'
import { Spinner } from '#/components/Spinner.tsx'

export function ProtectedLayout() {
	const { t } = useTranslation()

	// Make sure we have the required session details before rendering a protected route.
	const token = useAppSelector(selectToken)
	const { isLoading, isError, error, data } = useGetSessionQuery(undefined, { skip: !token })

	// If we don't have a token just redirect to login.
	if (!token) return <Navigate to="/login" replace />

	if (isLoading || (!data && !isError)) {
		return (
			<div className={styles.loadingArea}>
				<Spinner center />
			</div>
		)
	}

	if (isError) {
		const requestId = isApiError(error) ? error.requestId : 'unknown'
		return (
			<div className={styles.loadingArea}>
				<p>{t('error.body.failedToFetchSession', { requestId })}</p>
			</div>
		)
	}

	return (
		<>
			<Header />
			<main className={styles.container}>
				<Outlet />
			</main>
		</>
	)
}
