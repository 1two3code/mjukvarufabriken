import '#/assets/styles/global.css'
import '#/app/i18n.ts'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'
import * as Sentry from '@sentry/react'

import { App } from '#/app/App.tsx'
import { store } from '#/app/store.ts'

// SaaS Sentry (free tier), error tracking only. Empty DSN until a Sentry project exists
// (TODO-EXTERNAL) — no-op rather than initializing against nothing.
const sentryDsn = import.meta.env.VITE_SENTRY_DSN
if (sentryDsn) Sentry.init({ dsn: sentryDsn, environment: import.meta.env.MODE })

const container = document.getElementById('root')
if (!container) throw new Error("Root element with ID 'root' was not found in the document.")

createRoot(container).render(
	<StrictMode>
		<Provider store={store}>
			<App />
		</Provider>
	</StrictMode>
)
