/**
 * Minimal local typings for the small jsdom surface renderPage.script.ts uses. The published
 * @types/jsdom package would work too, but it drags the whole DOM lib into every workspace that
 * auto-includes @types/* (apps/job's fetch() calls then typecheck against lib.dom instead of
 * undici and fail) — so the harness declares just what it needs.
 */
declare module 'jsdom' {
	import type { EventEmitter } from 'node:events'

	export class VirtualConsole extends EventEmitter {}

	export type FromUrlOptions = {
		resources?: 'usable'
		runScripts?: 'dangerously' | 'outside-only'
		pretendToBeVisual?: boolean
		virtualConsole?: VirtualConsole
		beforeParse?: (window: JSDOM['window']) => void
	}

	export class JSDOM {
		static fromURL(url: string, options?: FromUrlOptions): Promise<JSDOM>
		window: {
			document: {
				getElementById(id: string): { innerHTML: string } | null
			}
		}
	}
}
