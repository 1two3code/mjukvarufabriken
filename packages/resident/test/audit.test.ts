import { ResidentAuditEntrySchema } from '@mf/models'

import { auditKey, createAuditLog, parseAuditLines, serialiseAuditLines } from '#/audit.ts'
import { createMonthlyCap, monthKey } from '#/cap.ts'
import { createMemoryObjectStore } from '#/store.ts'

const start = Date.parse('2026-09-03T23:59:00.000Z')

describe('audit log', () => {
	it('Appends one JSON line per action to the object of the day, in order', async () => {
		// Arrange
		const store = createMemoryObjectStore()
		let now = start
		const audit = createAuditLog({ store, now: () => now })

		// Act
		await audit.append('resident_started', { repository: 'acme/shop' })
		await audit.append('task_started', { title: 'Add search' }, 'abc12345')
		now += 2 * 60_000 // past midnight → a new object
		await audit.append('pr_opened', { url: 'https://github.com/acme/shop/pull/1' }, 'abc12345')
		await audit.flush()

		// Assert
		const day1 = store.objects.get(auditKey('2026-09-03'))!
		const lines = day1.trim().split('\n')
		expect(lines).toHaveLength(2)
		expect(day1.endsWith('\n')).toBe(true)
		const entries = lines.map(line => ResidentAuditEntrySchema.parse(JSON.parse(line)))
		expect(entries).toEqual([
			{
				time: '2026-09-03T23:59:00.000Z',
				type: 'resident_started',
				detail: { repository: 'acme/shop' },
			},
			{
				time: '2026-09-03T23:59:00.000Z',
				type: 'task_started',
				taskId: 'abc12345',
				detail: { title: 'Add search' },
			},
		])
		expect(parseAuditLines(store.objects.get(auditKey('2026-09-04')))).toEqual([
			{
				time: '2026-09-04T00:01:00.000Z',
				type: 'pr_opened',
				taskId: 'abc12345',
				detail: { url: 'https://github.com/acme/shop/pull/1' },
			},
		])
		expect(await audit.read('2026-09-03')).toEqual(entries)
	})

	it('Continues an existing day object after a restart and drops broken lines', async () => {
		// Arrange
		const store = createMemoryObjectStore()
		const existing = [{ time: '2026-09-03T10:00:00.000Z', type: 'paused' as const, detail: {} }]
		await store.put(auditKey('2026-09-03'), serialiseAuditLines(existing) + '{"trunc')

		// Act
		const audit = createAuditLog({ store, now: () => start })
		await audit.append('resumed', { by: 'api' })

		// Assert
		const entries = await audit.read('2026-09-03')
		expect(entries.map(entry => entry.type)).toEqual(['paused', 'resumed'])
		expect(await audit.read('2026-01-01')).toEqual([])
	})
})

describe('monthly cap', () => {
	it('Counts tokens per calendar month, persists the counter and reports when it is reached', async () => {
		// Arrange
		const store = createMemoryObjectStore()
		let now = start
		const cap = createMonthlyCap({ store, maxTokens: 1000, now: () => now })

		// Act + Assert
		expect(await cap.remaining()).toBe(1000)
		expect(await cap.add(400)).toBe(false)
		expect(await cap.add(600)).toBe(true)
		expect(await cap.reached()).toBe(true)
		expect(await cap.remaining()).toBe(0)
		expect(JSON.parse(store.objects.get(monthKey('2026-09'))!)).toEqual({
			month: '2026-09',
			usedTokens: 1000,
		})

		// A restart reads the persisted month
		const restarted = createMonthlyCap({ store, maxTokens: 1000, now: () => now })
		expect(await restarted.used()).toBe(1000)

		// A new month starts from zero
		now = Date.parse('2026-10-01T00:00:00.000Z')
		expect(await cap.month()).toBe('2026-10')
		expect(await cap.reached()).toBe(false)
		expect(await cap.remaining()).toBe(1000)
	})
})
