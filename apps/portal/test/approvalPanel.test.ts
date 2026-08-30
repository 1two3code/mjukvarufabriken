import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isOrderAwaitingApproval } from '@mf/models'

import { gateSummary } from '#/features/orders/approval.ts'

import type { ReactElement, ReactNode } from 'react'
import type { GateName, GateReport, Job, OrderStatus } from '@mf/models'

// Shared, per-test-controllable mock state for the hooks the panel calls. `vi.hoisted` runs before
// the `vi.mock` factories (which are themselves hoisted above the imports), so both can see it.
const hooks = vi.hoisted(() => ({
	approve: vi.fn(),
	approveState: { isLoading: false } as { isLoading: boolean },
	deliverables: { data: undefined as { repositoryUrl?: string; deployUrl?: string } | undefined },
}))

// Mock the data hooks so the panel renders without an RTK store or i18n runtime. We keep the real
// `gateSummary`, `isOrderAwaitingApproval` and `Button` so the test exercises the real logic.
vi.mock('#/features/orders/ordersApiSlice.ts', () => ({
	useApproveOrderMutation: () => [hooks.approve, hooks.approveState] as const,
}))
vi.mock('#/features/jobs/jobsApiSlice.ts', () => ({
	useGetJobDeliverablesQuery: () => hooks.deliverables,
}))
vi.mock('react-i18next', () => ({
	// Echo the key (and any interpolation payload) so assertions can see what was rendered.
	useTranslation: () => ({
		t: (key: string, opts?: Record<string, unknown>) =>
			opts ? `${key} ${JSON.stringify(opts)}` : key,
	}),
}))

const { ApprovalPanel } = await import('#/features/orders/ApprovalPanel.tsx')
const { Button } = await import('#/components/Button.tsx')

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

	// A real (renderer-free) component test: invoke the component with mocked hooks and walk the
	// React element tree it returns. This exercises the actual ApprovalPanel — the disabled logic
	// and the click handler — without pulling in a DOM or a test renderer.
	describe('ApprovalPanel component', () => {
		type El = {
			type: unknown
			props: { children?: ReactNode; disabled?: boolean; onClick?: () => void }
		}
		const isElement = (node: unknown): node is El =>
			typeof node === 'object' && node !== null && 'type' in node && 'props' in node

		/** Every plain-text/number leaf under a node, concatenated depth-first. */
		const textOf = (node: ReactNode): string => {
			if (node == null || typeof node === 'boolean') return ''
			if (typeof node === 'string' || typeof node === 'number') return String(node)
			if (Array.isArray(node)) return node.map(textOf).join(' ')
			if (isElement(node)) return textOf(node.props.children)
			return ''
		}

		/** The first element in the tree whose `type` is `target`. */
		const findByType = (node: ReactNode, target: unknown): El | undefined => {
			if (Array.isArray(node)) {
				for (const child of node) {
					const hit = findByType(child, target)
					if (hit) return hit
				}
				return undefined
			}
			if (!isElement(node)) return undefined
			if (node.type === target) return node
			return findByType(node.props.children, target)
		}

		const makeJob = (gates: GateReport[]): Job =>
			({ id: 'job-1', gates, repositoryUrl: 'https://example.test/repo' }) as unknown as Job

		const render = (status: OrderStatus, job?: Job): ReactElement | null =>
			ApprovalPanel({ orderId: 'order-1', status, job }) as ReactElement | null

		beforeEach(() => {
			hooks.approve.mockReset()
			hooks.approveState.isLoading = false
			hooks.deliverables.data = undefined
		})

		it('Renders nothing unless the order is awaiting approval', () => {
			expect(render('building', makeJob([makeGate('verify', true)]))).toBeNull()
			expect(render('delivered')).toBeNull()
		})

		it('Renders the quality-gate tally', () => {
			const tree = render(
				'awaiting_approval',
				makeJob([makeGate('verify', true), makeGate('review', true)])
			)
			expect(tree).not.toBeNull()
			const text = textOf(tree)
			expect(text).toContain('order.approval.title')
			// The gates line carries the {passed,total} interpolation payload our mock `t` echoes.
			expect(text).toContain('order.approval.gates')
			expect(text).toContain('"passed":2')
			expect(text).toContain('"total":2')
		})

		it('Disables approve when any gate is red (not only while in flight)', () => {
			const tree = render(
				'awaiting_approval',
				makeJob([makeGate('verify', true), makeGate('review', false)])
			)
			const button = findByType(tree, Button)
			expect(button?.props.disabled).toBe(true)
			expect(textOf(tree)).toContain('"passed":1')
		})

		it('Disables approve while the mutation is in flight even with green gates', () => {
			hooks.approveState.isLoading = true
			const tree = render('awaiting_approval', makeJob([makeGate('verify', true)]))
			expect(findByType(tree, Button)?.props.disabled).toBe(true)
		})

		it('Disables approve until the gates have loaded (nothing to approve yet)', () => {
			const tree = render('awaiting_approval', undefined)
			expect(findByType(tree, Button)?.props.disabled).toBe(true)
		})

		it('Enables approve and calls the mutation on click when every gate is green', () => {
			const tree = render(
				'awaiting_approval',
				makeJob([makeGate('verify', true), makeGate('review', true), makeGate('licence', true)])
			)
			const button = findByType(tree, Button)
			expect(button?.props.disabled).toBe(false)

			expect(hooks.approve).not.toHaveBeenCalled()
			button?.props.onClick?.()
			expect(hooks.approve).toHaveBeenCalledTimes(1)
			expect(hooks.approve).toHaveBeenCalledWith('order-1')
		})
	})
})
