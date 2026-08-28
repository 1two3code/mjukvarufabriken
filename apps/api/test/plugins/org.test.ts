import { OrgNotConfigured } from '#/plugins/org.ts'

import type { FastifyInstance } from 'fastify'

describe('org plugin (disabled / dark mode)', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		// Real org plugin; the mocked secrets leave ORG_LIFECYCLE_ENABLED off (no AWS clients newed up).
		app = await createTestApp({ skipMock: '#/plugins/org.ts' })
	})

	it('Reports itself unconfigured and refuses to vend', async () => {
		expect(app.org.configured).toBe(false)
		await expect(app.org.vend('acme')).rejects.toThrow(OrgNotConfigured)
	})

	it('Runs deprovision against an empty world (a safe no-op) rather than touching AWS', async () => {
		const dry = await app.org.deprovision({ customerSlug: 'acme' }, 'teardown')
		expect(dry).toMatchObject({ mode: 'teardown', dryRun: true, discovered: 0, fenced: 0 })

		// Even a confirmed teardown finds nothing to act on while unconfigured
		const confirmed = await app.org.deprovision({ customerSlug: 'acme' }, 'teardown', {
			dryRun: false,
		})
		expect(confirmed).toMatchObject({ dryRun: false, discovered: 0, fenced: 0 })
	})

	it('Runs redeploy dry (planned only) rather than touching AWS while unconfigured', async () => {
		const result = await app.org.redeploy(
			[{ id: 'row-1', serviceName: 'mf-1-app', config: { serviceName: 'mf-1-app' } }],
			{ dryRun: false }
		)
		// Forced dry-run while unconfigured — nothing is created, the service is merely planned
		expect(result).toMatchObject({ mode: 'resume', dryRun: true })
		expect(result.summary.planned).toBe(1)
		expect(result.items[0]).toMatchObject({ serviceName: 'mf-1-app', outcome: 'planned' })
	})
})
