// We disable the ESLint rule here because this is the designated place
// for creating the application rtk api instance.
// Read more here:
// https://github.com/reduxjs/redux-toolkit/discussions/2506#discussioncomment-3124916
/* eslint-disable @typescript-eslint/no-restricted-imports */

import { Mutex } from 'async-mutex'
import { isRejectedWithValue } from '@reduxjs/toolkit'
import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react'

import { clearSession, setTokens } from '#/features/session/sessionSlice.ts'
import { addToast } from '#/features/toasts/toastsSlice.ts'

import type { ApiError } from '@mf/models'
import type { Middleware, MiddlewareAPI, PayloadAction } from '@reduxjs/toolkit'
import type { BaseQueryFn, FetchArgs, FetchBaseQueryError } from '@reduxjs/toolkit/query'
import type { RootState } from '#/app/store.ts'

/**
 * Caching configurations for the API (seconds)
 */
export const ApiCaching = {
	/** No caching */
	none: 1,
	/** Cache data for 2 minutes */
	default: 120,
	/** Cache data for 8 hours */
	long: 8 * 60 * 60,
} as const

const baseQuery = fetchBaseQuery({
	baseUrl: import.meta.env.VITE_API_URL,
	prepareHeaders: (headers, { getState }) => {
		const token = (getState() as RootState).session.token ?? ''
		if (token) headers.append('Authorization', `Bearer ${token}`)
		return headers
	},
})

/**
 * Mutex instance to ensure that only one token refresh request is made at a time.
 * This prevents simultaneous refresh requests when multiple API calls fail with 401 errors.
 */
const mutex = new Mutex()
const baseQueryWithAuthGuard: BaseQueryFn<
	string | FetchArgs,
	unknown,
	FetchBaseQueryError | ApiError
> = async (args, api, extraOptions) => {
	await mutex.waitForUnlock()
	const result = await baseQuery(args, api, extraOptions)

	// Handle 401 errors by trying to refresh the token
	if (result.error && result.error.status === 401) {
		if (mutex.isLocked()) {
			await mutex.waitForUnlock()
			return await baseQuery(args, api, extraOptions)
		}

		const release = await mutex.acquire()
		try {
			const refreshToken = (api.getState() as RootState).session.refreshToken
			const refreshResult = await baseQuery(
				{ url: '/auth/refresh', method: 'POST', body: { refreshToken } },
				api,
				extraOptions
			)

			if (!refreshResult.data) {
				// Could not refresh the token, clear the session and redirect to login
				api.dispatch(clearSession())
				return result
			}

			// Update the tokens in the session and retry the original request
			api.dispatch(setTokens(refreshResult.data as { token: string; refreshToken: string }))
			return await baseQuery(args, api, extraOptions)
		} finally {
			release()
		}
	}

	// If the error is our custom error format, override the error object to be an ApiError
	if (result.error && (result.error.data as { error?: ApiError })?.error?.requestId) {
		const overriddenError = { ...(result.error.data as { error: ApiError }).error }
		return { ...result, error: overriddenError }
	}

	return result
}

export const appApi = createApi({
	baseQuery: baseQueryWithAuthGuard,
	endpoints: () => ({}),
	keepUnusedDataFor: ApiCaching.default,
})

// MARK: Api type guards
export const isApiError = (error: unknown): error is ApiError => {
	return (
		typeof error === 'object' &&
		error != null &&
		'requestId' in error &&
		typeof (error as Record<string, unknown>).requestId === 'string'
	)
}

// MARK: Middleware
export const apiErrorHandlingMiddleware: Middleware = (api: MiddlewareAPI) => next => action => {
	if (!isRejectedWithValue(action)) return next(action)
	const { payload } = action as PayloadAction<unknown>

	// Only show toasts for API errors with a translatable code
	if (!isApiError(payload) || !payload.code) return next(action)

	const translationKey = `api.error.${payload.code}`
	api.dispatch(
		addToast({
			id: crypto.randomUUID(),
			type: 'error',
			message: translationKey,
			translate: true,
			...(payload.variables && { variables: payload.variables }),
		})
	)
	return next(action)
}
