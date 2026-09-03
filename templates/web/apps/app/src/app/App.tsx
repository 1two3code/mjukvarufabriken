import { RouterProvider } from 'react-router-dom'

import { useAppDispatch } from '#/app/hooks.ts'
import { router } from '#/app/router.tsx'
import { useEffectOnce } from '#/hooks/useEffectOnce.ts'
import { loadTheme } from '#/features/theme/themeSlice.ts'
import { ToastList } from '#/features/toasts/ToastList.tsx'

import { BuiltBy } from '#/components/builtBy/BuiltBy.tsx'

export function App() {
	const dispatch = useAppDispatch()

	useEffectOnce(() => {
		document.title = import.meta.env.VITE_APP_TITLE
		dispatch(loadTheme())
	})

	return (
		<>
			<RouterProvider router={router} />
			{/* Delivery standard — outside the router so layout/route rewrites keep it (see BuiltBy) */}
			<BuiltBy />
			<ToastList />
		</>
	)
}
