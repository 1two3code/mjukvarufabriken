import { RouterProvider } from 'react-router-dom'

import { useAppDispatch } from '#/app/hooks.ts'
import { router } from '#/app/router.tsx'
import { useEffectOnce } from '#/hooks/useEffectOnce.ts'
import { loadTheme } from '#/features/theme/themeSlice.ts'
import { ToastList } from '#/features/toasts/ToastList.tsx'

export function App() {
	const dispatch = useAppDispatch()

	useEffectOnce(() => {
		dispatch(loadTheme())
	})

	return (
		<>
			<RouterProvider router={router} />
			<ToastList />
		</>
	)
}
