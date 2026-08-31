import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	judgeAnonymousProbe,
	parsePublicUrls,
	readPublicUrls,
} from '#job/delivery/authReconcile.ts'

describe('parsePublicUrls', () => {
	it('reads the Set literal of the template auth plugin', () => {
		expect(parsePublicUrls(`const publicUrls = new Set(['/bff/auth/refresh'])`)).toEqual([
			'/bff/auth/refresh',
		])
	})

	it('reads a typed / array-shaped declaration and dedupes', () => {
		expect(
			parsePublicUrls(
				`const publicUrls: Set<string> = new Set(['/bff/a', "/bff/b", '/bff/a'])`
			)
		).toEqual(['/bff/a', '/bff/b'])
	})

	it('a discovered-empty allowlist is [], an absent one is undefined', () => {
		expect(parsePublicUrls('const publicUrls = new Set([])')).toEqual([])
		expect(parsePublicUrls('const somethingElse = 1')).toBeUndefined()
	})

	it('is not fooled by a ] inside a comment', () => {
		expect(
			parsePublicUrls(
				`const publicUrls = new Set([
					'/bff/a', // see spec[0]
					'/bff/b',
				])`
			)
		).toEqual(['/bff/a', '/bff/b'])
	})
})

describe('readPublicUrls', () => {
	let root: string
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mf-authrec-'))
	})
	afterEach(() => rm(root, { recursive: true, force: true }))

	it('finds the allowlist in apps/<app>/src/plugins/auth.ts', async () => {
		await mkdir(join(root, 'apps', 'api', 'src', 'plugins'), { recursive: true })
		await writeFile(
			join(root, 'apps', 'api', 'src', 'plugins', 'auth.ts'),
			`const publicUrls = new Set(['/bff/auth/refresh', '/bff/guestbook'])`
		)
		expect(await readPublicUrls(root)).toEqual(['/bff/auth/refresh', '/bff/guestbook'])
	})

	it('returns undefined when no auth plugin declares one', async () => {
		expect(await readPublicUrls(root)).toBeUndefined()
	})
})

describe('judgeAnonymousProbe', () => {
	it('the guestbook regression shape: 401 route + empty publicUrls → FAIL', () => {
		const verdict = judgeAnonymousProbe('/bff/guestbook', 401, [])
		expect(verdict.ok).toBe(false)
		expect(verdict.reason).toContain('publicUrls')
		expect(verdict.reason).toContain('locked out')
	})

	it('a 401 on an ALLOWLISTED path is an allowlist mismatch, also a failure', () => {
		const verdict = judgeAnonymousProbe('/bff/guestbook', 401, ['/bff/guestbook'])
		expect(verdict.ok).toBe(false)
		expect(verdict.reason).toContain('listed in publicUrls')
	})

	it('404 and unreachable fail; 5xx fails (a 500 is not "the route exists")', () => {
		expect(judgeAnonymousProbe('/bff/x', 404, []).ok).toBe(false)
		expect(judgeAnonymousProbe('/bff/x', 0, []).ok).toBe(false)
		expect(judgeAnonymousProbe('/bff/x', 500, []).ok).toBe(false)
		expect(judgeAnonymousProbe('/bff/x', 503, []).reason).toContain('broken')
	})

	it('2xx/3xx/400 pass — the route answers the anonymous visitor', () => {
		expect(judgeAnonymousProbe('/bff/x', 200, []).ok).toBe(true)
		expect(judgeAnonymousProbe('/bff/x', 302, []).ok).toBe(true)
		expect(judgeAnonymousProbe('/bff/x', 400, []).ok).toBe(true)
	})

	it('never judges the template auth-bootstrap routes (logged-out 401/501 is their contract)', () => {
		expect(judgeAnonymousProbe('/bff/auth/refresh', 501, []).ok).toBe(true)
		expect(judgeAnonymousProbe('/bff/session', 401, []).ok).toBe(true)
		expect(judgeAnonymousProbe('/session', 401, []).ok).toBe(true)
	})
})
