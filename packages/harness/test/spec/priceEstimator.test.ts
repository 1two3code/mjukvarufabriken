import {
	demoPriceFromTiers,
	demoPriceSek,
	demoTierKey,
	estimatePrice,
	priceCeilingSek,
	priceForSize,
	sizeClass,
	sizePricesFromTiers,
	tierKeyForSize,
} from '#spec/priceEstimator.ts'

import type { PartialSpec, PricingTierRow, SpecFeature } from '@mf/models'

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
	it('Falls back to the decided ladder prices per size class, capped at the ceiling', () => {
		expect(priceForSize).toEqual({ S: 3_000, M: 4_000, L: 5_000 })
		expect(Math.max(...Object.values(priceForSize))).toBe(priceCeilingSek)
	})

	it('Classifies ≤ 3 features with ≤ 6 criteria as S', () => {
		const spec = baseSpec([feature('List', 2), feature('Create', 2), feature('Edit', 2)])
		expect(sizeClass(spec)).toBe('S')
		expect(estimatePrice(spec)).toEqual({ sizeClass: 'S', priceSek: 3_000 })
	})

	it('Classifies 3 features with 7 criteria as M', () => {
		const spec = baseSpec([feature('List', 3), feature('Create', 2), feature('Edit', 2)])
		expect(sizeClass(spec)).toBe('M')
	})

	it('Classifies 4–7 plain features as M', () => {
		const spec = baseSpec(['a', 'b', 'c', 'd', 'e'].map(title => feature(title)))
		expect(estimatePrice(spec)).toEqual({ sizeClass: 'M', priceSek: 4_000 })
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

	describe('prices from the tiers table', () => {
		const tier = (overrides: Partial<PricingTierRow>): PricingTierRow => ({
			id: 'tier-1',
			tierKey: 'build_s',
			name: 'Build (small)',
			price: 3_000,
			currency: 'SEK',
			description: '',
			effectiveFrom: '2026-08-31T00:00:00.000Z',
			createdAt: '2026-08-31T00:00:00.000Z',
			...overrides,
		})
		const at = new Date('2026-09-15T00:00:00.000Z')

		it('Reads the effective SEK row per size and falls back for missing sizes', () => {
			const tiers = [
				tier({ price: 2_500 }),
				tier({ id: 'tier-2', tierKey: 'build_l', price: 4_800 }),
				tier({ id: 'tier-3', tierKey: 'demo', price: 500 }),
			]
			expect(sizePricesFromTiers(tiers, at)).toEqual({ S: 2_500, L: 4_800 })

			const spec = baseSpec([feature('List', 1)])
			expect(estimatePrice(spec, sizePricesFromTiers(tiers, at)).priceSek).toBe(2_500)
			expect(estimatePrice(baseSpec([]), {})).toEqual({ sizeClass: 'S', priceSek: 3_000 })
		})

		it('Lets the latest non-future row win and ignores future and non-SEK rows', () => {
			const tiers = [
				tier({ price: 3_000, effectiveFrom: '2026-08-31T00:00:00.000Z' }),
				tier({ id: 'tier-2', price: 2_000, effectiveFrom: '2026-09-10T00:00:00.000Z' }),
				tier({ id: 'tier-3', price: 1_000, effectiveFrom: '2027-01-01T00:00:00.000Z' }),
				tier({
					id: 'tier-4',
					price: 100,
					currency: 'USD',
					effectiveFrom: '2026-09-12T00:00:00.000Z',
				}),
			]
			expect(sizePricesFromTiers(tiers, at)).toEqual({ S: 2_000 })
		})

		it('Caps any configured price at the hard ceiling', () => {
			const spec = baseSpec([feature('List', 1)])
			expect(estimatePrice(spec, { S: 9_000 }).priceSek).toBe(priceCeilingSek)
		})

		it('Maps every size class to a build tier key', () => {
			expect(tierKeyForSize).toEqual({ S: 'build_s', M: 'build_m', L: 'build_l' })
		})

		it('Prices a demo from the effective demo row, falling back to 500 kr, capped at the ceiling', () => {
			expect(demoTierKey).toBe('demo')
			expect(demoPriceSek).toBe(500)
			// No demo row (a fresh install, the in-memory db): the ladder default
			expect(demoPriceFromTiers([tier({ price: 2_500 })], at)).toBe(500)
			// The latest non-future SEK demo row wins; build rows never leak into the demo price
			const tiers = [
				tier({ tierKey: 'demo', price: 500, effectiveFrom: '2026-08-31T00:00:00.000Z' }),
				tier({
					id: 'tier-2',
					tierKey: 'demo',
					price: 450,
					effectiveFrom: '2026-09-10T00:00:00.000Z',
				}),
				tier({
					id: 'tier-3',
					tierKey: 'demo',
					price: 300,
					effectiveFrom: '2027-01-01T00:00:00.000Z',
				}),
				tier({ id: 'tier-4', tierKey: 'demo', price: 40, currency: 'USD' }),
				tier({ id: 'tier-5', tierKey: 'build_l', price: 4_800 }),
			]
			expect(demoPriceFromTiers(tiers, at)).toBe(450)
			expect(demoPriceFromTiers([tier({ tierKey: 'demo', price: 9_000 })], at)).toBe(
				priceCeilingSek
			)
		})
	})
})
