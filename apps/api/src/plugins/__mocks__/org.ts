import fp from 'fastify-plugin'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { DeprovisionMode, DeprovisionResult, Outcome } from '@mf/org'

const emptyTally = (): Record<Outcome, number> => ({
	planned: 0,
	suspended: 0,
	resumed: 0,
	deleted: 0,
	skipped: 0,
	'already-gone': 0,
	failed: 0,
})

/** A canned, well-formed deprovision result the mocked `org.deprovision` hands back. */
export const createMockDeprovisionResult = (
	mode: DeprovisionMode,
	options?: { dryRun?: boolean; customerSlug?: string; label?: string }
): DeprovisionResult => {
	const dryRun = options?.dryRun ?? true
	const outcome: Outcome = dryRun
		? 'planned'
		: mode === 'teardown'
			? 'deleted'
			: mode === 'suspend'
				? 'suspended'
				: 'resumed'
	const summary = emptyTally()
	summary[outcome] = 1
	return {
		mode,
		dryRun,
		customerSlug: options?.customerSlug,
		label: options?.label,
		discovered: 1,
		fenced: 1,
		skippedByFence: 0,
		entries: [
			{
				time: '2026-08-28T00:00:00.000Z',
				mode,
				arn: 'arn:aws:ecs:eu-north-1:123456789012:service/default/mf-11111111-acme',
				service: 'ecs',
				action: mode === 'teardown' ? 'delete' : mode,
				outcome,
				dryRun,
			},
		],
		summary,
	}
}

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['org'] = {
		configured: true,
		vend: vi.fn(async () => ({ accountId: '123456789012', reused: false })),
		deprovision: vi.fn(async (target, mode, options) =>
			createMockDeprovisionResult(mode, {
				dryRun: options?.dryRun,
				customerSlug: target.customerSlug,
				label: target.label,
			})
		),
	}

	app.decorate('org', mock)
}

export default fp(mockPlugin, { name: '#internal/org' })
