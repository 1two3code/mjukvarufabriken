import { combineSlices, configureStore } from '@reduxjs/toolkit'
import { setupListeners } from '@reduxjs/toolkit/query'

import { apiErrorHandlingMiddleware, appApi } from '#/app/api.ts'
import { sessionListenerMiddleware } from '#/features/session/sessionListeners.ts'
import { sessionSlice } from '#/features/session/sessionSlice.ts'
import { themeListenerMiddleware } from '#/features/theme/themeListeners.ts'
import { themeSlice } from '#/features/theme/themeSlice.ts'
import { toastsSlice } from '#/features/toasts/toastsSlice.ts'

export const store = configureStore({
	reducer: combineSlices(appApi, sessionSlice, themeSlice, toastsSlice),
	// Adding the api middleware enables caching, invalidation, polling,
	// and other useful features of `rtk-query`.
	middleware: getDefaultMiddleware => {
		return getDefaultMiddleware()
			.prepend(sessionListenerMiddleware, themeListenerMiddleware)
			.concat(appApi.middleware, apiErrorHandlingMiddleware)
	},
})

setupListeners(store.dispatch)

// Infer the `RootState` type from the root reducer
export type RootState = ReturnType<typeof store.getState>

// Infer the type of `store`
export type AppStore = typeof store

// Infer the `AppDispatch` type from the store itself
export type AppDispatch = AppStore['dispatch']
