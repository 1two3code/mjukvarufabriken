/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

interface ImportMetaEnv {
	readonly VITE_APP_VERSION: string
	readonly VITE_API_URL: string
	readonly VITE_APP_TITLE: string
	/** `1` shows "Sign in with GitHub" on the login page (the api must have the OAuth App) */
	readonly VITE_GITHUB_SIGNIN?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}
