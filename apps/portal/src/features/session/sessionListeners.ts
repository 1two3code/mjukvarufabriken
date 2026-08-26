import { createListenerMiddleware } from '@reduxjs/toolkit'

import { sessionApiSlice } from '#/features/session/sessionApiSlice.ts'
import { clearSession, setSessionDetails, setTokens } from '#/features/session/sessionSlice.ts'

import type { AppDispatch, RootState } from '#/app/store.ts'

const listener = createListenerMiddleware()
const registerListener = listener.startListening.withTypes<RootState, AppDispatch>()

registerListener({
	actionCreator: setTokens,
	effect: async (action, api) => {
		const { token, refreshToken } = action.payload
		localStorage.setItem('token', token)
		localStorage.setItem('refreshToken', refreshToken)

		// Invalidate session details when new tokens are set (login or token refresh)
		api.dispatch(sessionApiSlice.util.invalidateTags(['session']))
	},
})

registerListener({
	actionCreator: clearSession,
	effect: async (_action, api) => {
		localStorage.removeItem('token')
		localStorage.removeItem('refreshToken')
		api.dispatch(sessionApiSlice.util.resetApiState())
	},
})

// Keep the session details in sync with the getSession query
registerListener({
	matcher: sessionApiSlice.endpoints.getSession.matchFulfilled,
	effect: (action, api) => {
		api.dispatch(setSessionDetails(action.payload))
	},
})

export const sessionListenerMiddleware = listener.middleware
