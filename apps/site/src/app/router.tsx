import { createBrowserRouter } from 'react-router-dom'

import { PublicLayout } from '#/layouts/templates/PublicLayout.tsx'
import { HomePage } from '#/pages/HomePage.tsx'
import { NotFoundPage } from '#/pages/NotFoundPage.tsx'

export const router = createBrowserRouter([
	{
		element: <PublicLayout />,
		children: [
			{ path: '/', element: <HomePage /> },
			{ path: '*', element: <NotFoundPage /> },
		],
	},
])
