import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { safeRedirect } from '#/features/auth/postLoginRedirect.ts'

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
})
