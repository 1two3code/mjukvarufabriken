import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
	rememberPostLoginRedirect,
	safeRedirect,
	takePostLoginRedirect,
} from '#/features/auth/postLoginRedirect.ts'

const root = join(import.meta.dirname, '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

/**
 * The site's quote hand-off (wave 14, F1): `/login?redirect=/claim?order=…&token=…` must land
 * on a `/claim` route behind the session, and only same-origin paths may be honoured as the
 * post-login redirect (the token in the URL must never be sent to another origin).
 */
describe('Quote claim route', () => {
	it('Registers /claim behind the protected layout', () => {
		const source = read('src/app/router.tsx')
		const start = source.indexOf('element: <ProtectedLayout />')
		expect(start).toBeGreaterThan(-1)
		expect(source.slice(start)).toContain("path: '/claim'")
	})

	it.each([
		['/claim?order=o1&token=abc', '/claim?order=o1&token=abc'],
		['/orders', '/orders'],
		['//evil.example/claim', '/'],
		['https://evil.example/claim', '/'],
		['', '/'],
		[null, '/'],
		[undefined, '/'],
	])('safeRedirect(%s) → %s', (value, expected) => {
		expect(safeRedirect(value)).toBe(expected)
	})

	it('Remembers a safe redirect once, and a login visit without one forgets it', () => {
		// Arrange — a minimal localStorage (the portal tests run in node)
		const store = new Map<string, string>()
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => store.set(key, value),
			removeItem: (key: string) => store.delete(key),
		})

		// Act + Assert — remembered, then consumed exactly once
		rememberPostLoginRedirect('/claim?order=o1&token=abc')
		expect(takePostLoginRedirect()).toBe('/claim?order=o1&token=abc')
		expect(takePostLoginRedirect()).toBeNull()

		// A stale hand-off does not survive a plain `/login` (no redirect) or an unsafe one
		rememberPostLoginRedirect('/claim?order=o1&token=abc')
		rememberPostLoginRedirect(null)
		expect(takePostLoginRedirect()).toBeNull()
		rememberPostLoginRedirect('/claim?order=o1&token=abc')
		rememberPostLoginRedirect('https://evil.example/claim')
		expect(takePostLoginRedirect()).toBeNull()

		vi.unstubAllGlobals()
	})
})
