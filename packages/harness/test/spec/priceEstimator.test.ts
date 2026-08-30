import { estimatePrice, priceForSize, sizeClass } from '#spec/priceEstimator.ts'

import type { PartialSpec, SpecFeature } from '@mf/models'

const feature = (title: string, criteria = 1, description = ''): SpecFeature => ({
	title,
	description,
	acceptanceCriteria: Array.from({ length: criteria }, (_, i) => `${title} criterion ${i + 1}`),
})

const baseSpec = (features: SpecFeature[]): PartialSpec => ({
	goal: 'A simple booking tool for a small gym',
	users: ['members'],
	features,
	nonGoals: [],
	stackConstraints: [],
})

describe('priceEstimator', () => {
	it('Maps size classes to the fixed price list', () => {
		expect(priceForSize).toEqual({ S: 15_000, M: 45_000, L: 120_000 })
	})

	it('Classifies ≤ 3 features with ≤ 6 criteria as S', () => {
		const spec = baseSpec([feature('List', 2), feature('Create', 2), feature('Edit', 2)])
		expect(sizeClass(spec)).toBe('S')
		expect(estimatePrice(spec)).toEqual({ sizeClass: 'S', priceSek: 15_000 })
	})

	it('Classifies 3 features with 7 criteria as M', () => {
		const spec = baseSpec([feature('List', 3), feature('Create', 2), feature('Edit', 2)])
		expect(sizeClass(spec)).toBe('M')
	})

	it('Classifies 4–7 plain features as M', () => {
		const spec = baseSpec(['a', 'b', 'c', 'd', 'e'].map(title => feature(title)))
		expect(estimatePrice(spec)).toEqual({ sizeClass: 'M', priceSek: 45_000 })
	})

	it('Classifies ≥ 8 features as L', () => {
		const spec = baseSpec(Array.from({ length: 8 }, (_, i) => feature(`f${i}`)))
		expect(sizeClass(spec)).toBe('L')
	})

	it('Classifies payments as L (sv + en)', () => {
		expect(sizeClass(baseSpec([feature('Checkout', 1, 'Pay with Stripe')]))).toBe('L')
		expect(sizeClass(baseSpec([feature('Betalning', 1, 'Kunden betalar med Swish')]))).toBe('L')
	})

	it('Classifies auth with roles as L, but plain login as S', () => {
		expect(sizeClass(baseSpec([feature('Login', 1, 'Users log in with email')]))).toBe('S')
		expect(
			sizeClass(baseSpec([feature('Login', 1, 'Users log in; admins manage other users')]))
		).toBe('L')
	})

	it('Classifies two or more third-party integrations as L, one as not', () => {
		const one = baseSpec([feature('Sync', 1, 'Integration with Fortnox')])
		const two = baseSpec([
			feature('Sync', 1, 'Integration with Fortnox'),
			feature('Notify', 1, 'Webhook to Slack'),
		])
		expect(sizeClass(one)).toBe('S')
		expect(sizeClass(two)).toBe('L')
	})

	it('Classifies realtime features as L', () => {
		expect(sizeClass(baseSpec([feature('Chat', 1, 'Realtidsuppdateringar via websocket')]))).toBe(
			'L'
		)
	})

	it('Handles an empty partial spec as S', () => {
		expect(sizeClass({})).toBe('S')
	})
})
