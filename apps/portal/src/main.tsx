import '#/assets/styles/global.css'
import '#/app/i18n.ts'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'react-redux'

import { App } from '#/app/App.tsx'
import { store } from '#/app/store.ts'

const container = document.getElementById('root')
if (!container) throw new Error("Root element with ID 'root' was not found in the document.")

createRoot(container).render(
	<StrictMode>
		<Provider store={store}>
			<App />
		</Provider>
	</StrictMode>
)
