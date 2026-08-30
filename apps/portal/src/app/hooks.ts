// This file serves as a central hub for re-exporting pre-typed Redux hooks.
// These imports are restricted elsewhere to ensure consistent
// usage of typed hooks throughout the application.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { useDispatch, useSelector } from 'react-redux'

import type { AppDispatch, RootState } from '#/app/store.ts'

// Use throughout your app instead of plain `useDispatch` and `useSelector`
export const useAppDispatch = useDispatch.withTypes<AppDispatch>()
export const useAppSelector = useSelector.withTypes<RootState>()
