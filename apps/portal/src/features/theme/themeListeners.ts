import { createListenerMiddleware } from '@reduxjs/toolkit'

import { loadTheme } from '#/features/theme/themeSlice.ts'

import type { AppDispatch, RootState } from '#/app/store.ts'

const listener = createListenerMiddleware()
const registerListener = listener.startListening.withTypes<RootState, AppDispatch>()

registerListener({
	actionCreator: loadTheme,
	effect: async (_action, api) => {
		const { theme } = api.getState().theme
		localStorage.setItem('theme', theme)
		document.documentElement.setAttribute('data-theme', theme)
	},
})

export const themeListenerMiddleware = listener.middleware
