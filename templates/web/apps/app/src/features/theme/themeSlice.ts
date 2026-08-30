import { createSlice } from '@reduxjs/toolkit'

import type { PayloadAction } from '@reduxjs/toolkit'

export const themes = ['light', 'dark', 'system'] as const

export type Theme = (typeof themes)[number]

const isTheme = (value: unknown): value is Theme => themes.includes(value as Theme)

const storedTheme = localStorage.getItem('theme')

export type ThemeState = { theme: Theme }

const initialState: ThemeState = { theme: isTheme(storedTheme) ? storedTheme : 'system' }

export const themeSlice = createSlice({
	name: 'theme',
	initialState,
	selectors: { selectTheme: state => state.theme },
	reducers: create => ({
		loadTheme: create.reducer((state, action: PayloadAction<Theme | undefined>) => {
			state.theme = action.payload ?? initialState.theme
		}),
	}),
})

// Action exports
export const { loadTheme } = themeSlice.actions

// Selector exports
export const { selectTheme } = themeSlice.selectors
