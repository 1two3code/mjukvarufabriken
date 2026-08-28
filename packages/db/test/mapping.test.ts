import { createAuthRepository, toMagicLink, toRefreshToken } from '#/auth.ts'
import { toSpecDraft } from '#/orders.ts'
import { getOrg, getUser, toOrg, toUser } from '#/users.ts'

import type { Db } from '#/index.ts'

/** A Db whose sql throws on use: the guards must return before touching Postgres */
const untouchable = {
	sql: () => {
		throw new Error('sql must not be called')
	},
} as unknown as Db

const at = new Date('2026-08-26T10:00:00.000Z')

describe('row mapping', () => {
	it('Maps an order row to a SpecDraft with optional fields dropped when null', () => {
		expect(
			toSpecDraft({
				id: 'demo',
				org_id: '',
				created_by: null,
				name: '',
				status: 'drafting',
				spec: { goal: 'g' },
				messages: [],
				open_questions: ['q'],
				size_class: null,
				price_sek: null,
				frozen_at: null,
				approve_before_deliver: false,
				created_at: at,
				updated_at: at,
			})
		).toEqual({
			orderId: 'demo',
			orgId: undefined,
			status: 'drafting',
			spec: { goal: 'g' },
			messages: [],
			openQuestions: ['q'],
			priceSek: undefined,
			frozenAt: undefined,
		})
		expect(
			toSpecDraft({
				id: 'demo',
				org_id: 'org',
				created_by: 'u',
				name: 'Gym booking',
				status: 'frozen',
				spec: { goal: 'g', sizeClass: 'M' },
				messages: [],
				open_questions: [],
				size_class: 'M',
				price_sek: 45_000,
				frozen_at: at,
				approve_before_deliver: true,
				created_at: at,
				updated_at: at,
			})
		).toMatchObject({ orgId: 'org', priceSek: 45_000, frozenAt: at.toISOString() })
	})

	it('Maps user, org and auth rows to models with ISO timestamps', () => {
		expect(
			toUser({
				id: 'u',
				org_id: 'o',
				email: 'a@x.se',
				name: null,
				role: 'admin',
				github_id: null,
				github_login: null,
				created_at: at,
			})
		).toEqual({
			id: 'u',
			orgId: 'o',
			email: 'a@x.se',
			name: undefined,
			role: 'admin',
			githubId: undefined,
			githubLogin: undefined,
			createdAt: at.toISOString(),
		})
		expect(
			toUser({
				id: 'u',
				org_id: 'o',
				email: 'a@x.se',
				name: 'Anna',
				role: 'user',
				github_id: '42',
				github_login: 'anna',
				created_at: at,
			})
		).toMatchObject({ githubId: '42', githubLogin: 'anna' })
		expect(toOrg({ id: 'o', name: 'x.se', org_number: null, created_at: at })).toEqual({
			id: 'o',
			name: 'x.se',
			createdAt: at.toISOString(),
		})
		expect(
			toMagicLink({
				token_hash: 'h',
				email: 'a@x.se',
				purpose: 'email',
				expires_at: at,
				used_at: null,
				created_at: at,
			})
		).toEqual({
			tokenHash: 'h',
			email: 'a@x.se',
			purpose: 'email',
			createdAt: at.toISOString(),
			expiresAt: at.toISOString(),
			usedAt: undefined,
		})
		expect(
			toRefreshToken({
				token_hash: 'h',
				user_id: 'u',
				expires_at: at,
				revoked_at: at,
				created_at: at,
			})
		).toMatchObject({ tokenHash: 'h', userId: 'u', revokedAt: at.toISOString() })
	})

	it('Treats malformed uuids as not found without querying', async () => {
		await expect(getUser(untouchable, 'user-1')).resolves.toBeUndefined()
		await expect(getOrg(untouchable, 'org-1')).resolves.toBeUndefined()
		await expect(
			createAuthRepository(untouchable).insertRefreshToken({
				tokenHash: 'h',
				userId: 'user-1',
				expiresAt: at,
			})
		).rejects.toThrow(/not a uuid/)
	})
})
