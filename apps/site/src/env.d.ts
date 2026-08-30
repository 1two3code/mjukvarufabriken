/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

interface ImportMetaEnv {
	readonly VITE_APP_VERSION: string
	readonly VITE_API_URL: string
	readonly VITE_APP_TITLE: string
	readonly VITE_PORTAL_URL: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}

/** Markdown documents rendered at build time by the `markdown` plugin (src/build/markdown.ts) */
declare module '*.md' {
	import type { MarkdownModule } from '#/build/markdown.ts'

	const document: MarkdownModule
	// eslint-disable-next-line no-restricted-syntax -- Vite module shape
	export default document
}
