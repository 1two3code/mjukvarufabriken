import type * as housekeeping from '#/lib/housekeeping.ts'

// The scheduler is unit-tested in test/lib/housekeeping.test.ts; here only its wiring matters
vi.mock('#/lib/housekeeping.ts', async importOriginal => ({
	...(await importOriginal<typeof housekeeping>()),
	scheduleHousekeeping: vi.fn(),
}))

describe('quoteSweeper plugin', () => {
	it('Schedules the anonymous-quote retention sweep through the shared scheduler', async () => {
		// Arrange
		const { scheduleHousekeeping } = await import('#/lib/housekeeping.ts')

		// Act
		const app = await createTestApp()

		// Assert
		const call = vi
			.mocked(scheduleHousekeeping)
			.mock.calls.findLast(([, name]) => name === 'Anonymous quote sweep')
		expect(call).toBeDefined()
		await call![2]()
		expect(app.quoteService.sweepUnclaimed).toHaveBeenCalledTimes(1)
	})
})
