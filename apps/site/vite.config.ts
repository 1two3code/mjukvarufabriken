import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import svgr from 'vite-plugin-svgr'
import react from '@vitejs/plugin-react'

import { markdown } from './src/build/markdown.ts'

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
		markdown(),
		i18nHotReload(),
		react({ babel: { plugins: [['babel-plugin-react-compiler']] } }),
	],
	resolve: {
		// The legal drafts live outside the app root; the markdown plugin renders them at build time
		alias: { '@legal': resolve(import.meta.dirname, '../../legal') },
	},
	server: {
		open: true,
		port: 5175,
		// Same-origin /bff in every mode; locally it is proxied to the api
		proxy: { '/bff': 'http://localhost:5174' },
	},
	preview: { port: 5175 },
	build: {
		chunkSizeWarningLimit: 1024,
	},
	css: {
		devSourcemap: true,
		transformer: 'lightningcss',
		lightningcss: { cssModules: true, drafts: { customMedia: true } },
	},
})
