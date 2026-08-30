import type * as housekeeping from '#/lib/housekeeping.ts'

// The scheduler is unit-tested in test/lib/housekeeping.test.ts and the sweep in
// test/lib/jobSweep.test.ts; here only the wiring matters.
vi.mock('#/lib/housekeeping.ts', async importOriginal => ({
	...(await importOriginal<typeof housekeeping>()),
	scheduleHousekeeping: vi.fn(),
}))

describe('jobSweeper plugin', () => {
	it('Schedules the liveness sweep through the shared housekeeping scheduler', async () => {
		// Arrange
		const { scheduleHousekeeping } = await import('#/lib/housekeeping.ts')

		// Act
		await createTestApp()

		// Assert
		const call = vi
			.mocked(scheduleHousekeeping)
			.mock.calls.findLast(([, name]) => name === 'Job liveness sweep')
		expect(call).toBeDefined()
	})
})
