/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

interface ImportMetaEnv {
	readonly VITE_APP_VERSION: string
	readonly VITE_API_URL: string
	readonly VITE_APP_TITLE: string
	/** Target of the "Built by Mjukvaruhuset" footer; empty hides the footer (components/builtBy) */
	readonly VITE_BUILT_BY_URL: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
