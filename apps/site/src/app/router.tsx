import { createBrowserRouter } from 'react-router-dom'

import { languages, pagePaths, pages } from '#/app/routes.ts'

import { SiteLayout } from '#/layouts/templates/SiteLayout.tsx'
import { ContactPage } from '#/pages/ContactPage.tsx'
import { DemosPage } from '#/pages/DemosPage.tsx'
import { HomePage } from '#/pages/HomePage.tsx'
import { HowItWorksPage } from '#/pages/HowItWorksPage.tsx'
import { NotFoundPage } from '#/pages/NotFoundPage.tsx'
import { PricingPage } from '#/pages/PricingPage.tsx'
import { PrivacyPage } from '#/pages/PrivacyPage.tsx'
import { TermsPage } from '#/pages/TermsPage.tsx'

import type { Page, RouteHandle } from '#/app/routes.ts'

const elements: Record<Page, React.ReactNode> = {
	home: <HomePage />,
	howItWorks: <HowItWorksPage />,
	demos: <DemosPage />,
	pricing: <PricingPage />,
	contact: <ContactPage />,
	terms: <TermsPage />,
	privacy: <PrivacyPage />,
}

/** One route per page and language, each tagged with a `RouteHandle` for the layout */
const pageRoutes = pages.flatMap(page =>
	languages.map(language => ({
		path: pagePaths[page][language],
		element: elements[page],
		handle: { language, page } satisfies RouteHandle,
	}))
)

export const router = createBrowserRouter([
	{
		element: <SiteLayout />,
		children: [...pageRoutes, { path: '*', element: <NotFoundPage /> }],
	},
])
