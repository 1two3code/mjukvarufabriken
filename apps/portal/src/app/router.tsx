import { createBrowserRouter } from 'react-router-dom'

import { ProtectedLayout } from '#/layouts/templates/ProtectedLayout.tsx'
import { PublicLayout } from '#/layouts/templates/PublicLayout.tsx'
import { AuthCallbackPage } from '#/pages/AuthCallbackPage.tsx'
import { HomePage } from '#/pages/HomePage.tsx'
import { ItemsPage } from '#/pages/ItemsPage.tsx'
import { LoginPage } from '#/pages/LoginPage.tsx'
import { NotFoundPage } from '#/pages/NotFoundPage.tsx'
import { SpecPage } from '#/pages/SpecPage.tsx'

export const router = createBrowserRouter([
	{
		element: <PublicLayout />,
		children: [
			{ path: '/login', element: <LoginPage /> },
			{ path: '/auth/callback', element: <AuthCallbackPage /> },
			{ path: '*', element: <NotFoundPage /> },
		],
	},
	{
		path: '/',
		element: <ProtectedLayout />,
		children: [
			{ path: '/', element: <HomePage /> },
			{ path: '/items', element: <ItemsPage /> },
			{ path: '/orders/:orderId/spec', element: <SpecPage /> },
		],
	},
])
