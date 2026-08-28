import { createAuditLog } from '#/audit.ts'

describe('createAuditLog', () => {
	it('Stamps a timestamp, validates and returns entries in order', () => {
		const emitted: string[] = []
		const log = createAuditLog({
			now: () => Date.parse('2026-08-28T10:00:00.000Z'),
			log: entry => emitted.push(entry.outcome),
		})

		log.record({ mode: 'teardown', arn: 'arn:a', service: 'ecs', action: 'delete', outcome: 'deleted', dryRun: false })
		log.record({ mode: 'teardown', arn: 'arn:b', service: 's3', action: 'delete', outcome: 'already-gone', dryRun: false })

		const entries = log.entries()
		expect(entries).toHaveLength(2)
		expect(entries[0]).toMatchObject({ arn: 'arn:a', time: '2026-08-28T10:00:00.000Z' })
		expect(emitted).toEqual(['deleted', 'already-gone'])
	})

	it('Rejects an entry that fails schema validation', () => {
		const log = createAuditLog()
		expect(() =>
			log.record({
				mode: 'teardown',
				arn: '',
				service: 'ecs',
				action: 'delete',
				// @ts-expect-error invalid outcome
				outcome: 'exploded',
				dryRun: false,
			})
		).toThrow()
	})
})
