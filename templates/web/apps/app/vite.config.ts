import { defineConfig } from 'vite'
import svgr from 'vite-plugin-svgr'
import react from '@vitejs/plugin-react'

import type { PluginOption } from 'vite'

// Custom vite plugin to handle i18n hot updates
function i18nHotReload(): PluginOption {
	return {
		name: 'i18n-hot-reload',
		handleHotUpdate({ file, server }) {
			if (!file.includes('locales') || !file.endsWith('.json')) return
			server.hot.send({ type: 'custom', event: 'i18n-update' })
		},
	}
}

// eslint-disable-next-line no-restricted-syntax
export default defineConfig({
	plugins: [
		svgr(),
		i18nHotReload(),
		react({ babel: { plugins: [['babel-plugin-react-compiler']] } }),
	],
	server: { open: true, port: 5173 },
	preview: { port: 5173 },
	build: {
		chunkSizeWarningLimit: 1024,
	},
	css: {
		devSourcemap: true,
		transformer: 'lightningcss',
		lightningcss: { cssModules: true, drafts: { customMedia: true } },
	},
})
