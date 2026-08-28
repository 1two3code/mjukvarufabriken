import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isOrderAwaitingApproval } from '@mf/models'

import { gateSummary } from '#/features/orders/approval.ts'

import type { GateName, GateReport } from '@mf/models'

const makeGate = (name: GateName, ok: boolean): GateReport => ({
	name,
	ok,
	startedAt: '2026-08-27T00:00:00.000Z',
	durationMs: 1000,
	tokens: 100,
	summary: ok ? 'passed' : 'failed',
})

const root = join(import.meta.dirname, '..')
const loadLocale = (language: string): Record<string, string> =>
	JSON.parse(readFileSync(join(root, 'public/locales', `${language}.json`), 'utf8'))

describe('Approval panel (approve-before-deliver)', () => {
	describe('gateSummary', () => {
		it('Tallies passed / failed gates and flags an all-green set', () => {
			const gates = [makeGate('verify', true), makeGate('review', true), makeGate('licence', true)]
			expect(gateSummary(gates)).toEqual({ total: 3, passed: 3, failed: 0, allPassed: true })
		})

		it('Is not all-passed when any gate is red', () => {
			const gates = [makeGate('verify', true), makeGate('review', false)]
			expect(gateSummary(gates)).toEqual({ total: 2, passed: 1, failed: 1, allPassed: false })
		})

		it('Treats an empty / missing set as nothing to approve yet', () => {
			expect(gateSummary([])).toEqual({ total: 0, passed: 0, failed: 0, allPassed: false })
			expect(gateSummary()).toEqual({ total: 0, passed: 0, failed: 0, allPassed: false })
		})
	})

	describe('isOrderAwaitingApproval (the panel gate)', () => {
		it('Is true only for awaiting_approval', () => {
			expect(isOrderAwaitingApproval('awaiting_approval')).toBe(true)
			expect(isOrderAwaitingApproval('building')).toBe(false)
			expect(isOrderAwaitingApproval('delivered')).toBe(false)
		})
	})

	describe('locale strings (sv + en)', () => {
		const keys = [
			'order.status.awaiting_approval',
			'order.next.approval',
			'order.approval.title',
			'order.approval.intro',
			'order.approval.gates',
			'order.approval.preview',
			'order.approval.diff',
			'order.approval.approve',
			'order.approval.hint',
		]

		for (const language of ['en', 'sv'] as const) {
			it(`Defines every approval key in ${language}`, () => {
				const locale = loadLocale(language)
				for (const key of keys) {
					expect(locale[key], `${language}:${key}`).toBeTruthy()
				}
			})
		}

		it('Keeps the {{passed}}/{{total}} interpolation in both languages', () => {
			for (const language of ['en', 'sv'] as const) {
				const value = loadLocale(language)['order.approval.gates']!
				expect(value, language).toContain('{{passed}}')
				expect(value, language).toContain('{{total}}')
			}
		})
	})
})
