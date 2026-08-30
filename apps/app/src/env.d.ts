/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

interface ImportMetaEnv {
	readonly VITE_APP_VERSION: string
	readonly VITE_API_URL: string
	readonly VITE_APP_TITLE: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
