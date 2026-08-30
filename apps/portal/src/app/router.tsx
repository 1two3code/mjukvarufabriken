import { createBrowserRouter } from 'react-router-dom'

import { ProtectedLayout } from '#/layouts/templates/ProtectedLayout.tsx'
import { PublicLayout } from '#/layouts/templates/PublicLayout.tsx'
import { AdminCustomersPage } from '#/pages/AdminCustomersPage.tsx'
import { AdminJobsPage } from '#/pages/AdminJobsPage.tsx'
import { AdminOverviewPage } from '#/pages/AdminOverviewPage.tsx'
import { AdminPricingPage } from '#/pages/AdminPricingPage.tsx'
import { AdminResidentPage } from '#/pages/AdminResidentPage.tsx'
import { AuthCallbackPage } from '#/pages/AuthCallbackPage.tsx'
import { GithubCallbackPage } from '#/pages/GithubCallbackPage.tsx'
import { HomePage } from '#/pages/HomePage.tsx'
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
			{ path: '/orders', element: <OrdersPage /> },
			{ path: '/orders/:orderId', element: <OrderPage /> },
			{ path: '/admin', element: <AdminOverviewPage /> },
			{ path: '/admin/jobs', element: <AdminJobsPage /> },
			{ path: '/admin/customers', element: <AdminCustomersPage /> },
			{ path: '/admin/resident', element: <AdminResidentPage /> },
			{ path: '/admin/pricing', element: <AdminPricingPage /> },
			// /admin/margin (M12, when built): per-customer margin + aggregate P&L over time
			{ path: '/orders/:orderId/spec', element: <SpecPage /> },
			{ path: '/orders/:orderId/job', element: <JobPage /> },
		],
	},
])
