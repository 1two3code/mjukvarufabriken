import { createSlice } from '@reduxjs/toolkit'

import type { PayloadAction } from '@reduxjs/toolkit'
import type { FrontendSession } from '@template/models'

export type SessionState = {
	token: string | null
	refreshToken: string | null
	details?: FrontendSession
}

const initialState: SessionState = {
	token: localStorage.getItem('token'),
	refreshToken: localStorage.getItem('refreshToken'),
	details: undefined,
}

export const sessionSlice = createSlice({
	name: 'session',
	initialState,
	selectors: {
		selectToken: state => state.token,
		selectSession: state => {
			if (!state.details) throw new Error('Session details not available')
			return state.details
		},
	},
	reducers: create => ({
		setTokens: create.reducer(
			(state, action: PayloadAction<{ token: string; refreshToken: string }>) => {
				state.token = action.payload.token
				state.refreshToken = action.payload.refreshToken
			}
		),
		clearSession: create.reducer(state => {
			state.token = null
			state.refreshToken = null
			state.details = undefined
		}),
		// Dispatched from sessionListeners when the getSession query fulfils. Deliberately not an
		// extraReducers matcher: importing the api slice here creates an import cycle through
		// app/api.ts that leaves `appApi` undefined in the production bundle.
		setSessionDetails: create.reducer((state, action: PayloadAction<FrontendSession>) => {
			state.details = action.payload
		}),
	}),
})

// Action exports
export const { clearSession, setSessionDetails, setTokens } = sessionSlice.actions

// Selector exports
export const { selectToken, selectSession } = sessionSlice.selectors
