import { createSlice } from '@reduxjs/toolkit'

import type { PayloadAction } from '@reduxjs/toolkit'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export type Toast = {
	id: string
	type: ToastType
	message: string
	translate?: boolean
	variables?: Record<string, string | number>
}

type ToastsState = {
	toasts: Toast[]
}

const initialState: ToastsState = {
	toasts: [],
}

export const toastsSlice = createSlice({
	name: 'toasts',
	initialState,
	selectors: { selectToasts: state => state.toasts },
	reducers: {
		addToast: (state, action: PayloadAction<Toast>) => {
			if (state.toasts.some(t => t.id === action.payload.id)) return
			state.toasts.push(action.payload)
		},
		removeToast: (state, action: PayloadAction<{ id: string }>) => {
			state.toasts = state.toasts.filter(toast => toast.id !== action.payload.id)
		},
	},
})

// Action exports
export const { addToast, removeToast } = toastsSlice.actions

// Selector exports
export const { selectToasts } = toastsSlice.selectors
