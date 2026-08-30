import { createBrowserRouter } from 'react-router-dom'

import { ProtectedLayout } from '#/layouts/templates/ProtectedLayout.tsx'
import { PublicLayout } from '#/layouts/templates/PublicLayout.tsx'
import { AdminPage } from '#/pages/AdminPage.tsx'
import { AdminResidentPage } from '#/pages/AdminResidentPage.tsx'
import { AuthCallbackPage } from '#/pages/AuthCallbackPage.tsx'
import { GithubCallbackPage } from '#/pages/GithubCallbackPage.tsx'
import { HomePage } from '#/pages/HomePage.tsx'
import { ItemsPage } from '#/pages/ItemsPage.tsx'
import { JobPage } from '#/pages/JobPage.tsx'
import { LoginPage } from '#/pages/LoginPage.tsx'
import { NotFoundPage } from '#/pages/NotFoundPage.tsx'
import { OrderPage } from '#/pages/OrderPage.tsx'
import { OrdersPage } from '#/pages/OrdersPage.tsx'
import { SpecPage } from '#/pages/SpecPage.tsx'

export const router = createBrowserRouter([
	{
		element: <PublicLayout />,
		children: [
			{ path: '/login', element: <LoginPage /> },
			{ path: '/auth/callback', element: <AuthCallbackPage /> },
			{ path: '/auth/github/callback', element: <GithubCallbackPage /> },
			{ path: '*', element: <NotFoundPage /> },
		],
	},
	{
		path: '/',
		element: <ProtectedLayout />,
		children: [
			{ path: '/', element: <HomePage /> },
			{ path: '/items', element: <ItemsPage /> },
			{ path: '/orders', element: <OrdersPage /> },
			{ path: '/orders/:orderId', element: <OrderPage /> },
			{ path: '/admin', element: <AdminPage /> },
			{ path: '/admin/resident', element: <AdminResidentPage /> },
			{ path: '/orders/:orderId/spec', element: <SpecPage /> },
			{ path: '/orders/:orderId/job', element: <JobPage /> },
		],
	},
])
