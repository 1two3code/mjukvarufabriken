import {
	housekeepingIntervalMs,
	housekeepingJitterMs,
	scheduleHousekeeping,
} from '#/lib/housekeeping.ts'

import type { FastifyInstance } from 'fastify'

/** The slice of the app the scheduler touches */
const createApp = (backend: 'postgres' | 'memory', available = true) => {
	const hooks: (() => void)[] = []
	const app = {
		db: { backend, available },
		log: { warn: vi.fn() },
		addHook: vi.fn((_name: string, hook: () => void) => hooks.push(hook)),
	}
	return { app: app as unknown as FastifyInstance, hooks, log: app.log }
}

describe('scheduleHousekeeping', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('Runs at boot and then hourly with a random jitter on Postgres', async () => {
		// Arrange
		const { app } = createApp('postgres')
		const task = vi.fn().mockResolvedValue(undefined)
		vi.spyOn(Math, 'random').mockReturnValue(0.5)

		// Act
		await scheduleHousekeeping(app, 'Test prune', task)

		// Assert
		expect(task).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(housekeepingIntervalMs)
		expect(task).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(housekeepingJitterMs / 2)
		expect(task).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(housekeepingIntervalMs + housekeepingJitterMs / 2)
		expect(task).toHaveBeenCalledTimes(3)
	})

	it('Logs a failed run and keeps the schedule', async () => {
		// Arrange
		const { app, log } = createApp('postgres')
		const task = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined)

		// Act
		await scheduleHousekeeping(app, 'Test prune', task)
		await vi.advanceTimersByTimeAsync(housekeepingIntervalMs + housekeepingJitterMs)

		// Assert
		expect(log.warn).toHaveBeenCalledWith({ err: expect.any(Error) }, 'Test prune failed')
		expect(task).toHaveBeenCalledTimes(2)
	})

	it('Stops when the app closes', async () => {
		// Arrange
		const { app, hooks } = createApp('postgres')
		const task = vi.fn().mockResolvedValue(undefined)
		await scheduleHousekeeping(app, 'Test prune', task)

		// Act
		for (const hook of hooks) hook()
		await vi.advanceTimersByTimeAsync(2 * (housekeepingIntervalMs + housekeepingJitterMs))

		// Assert
		expect(task).toHaveBeenCalledTimes(1)
	})

	it('Does nothing on the memory backend or when the database is unavailable', async () => {
		// Arrange
		const memory = createApp('memory')
		const unavailable = createApp('postgres', false)
		const task = vi.fn().mockResolvedValue(undefined)

		// Act
		await scheduleHousekeeping(memory.app, 'Test prune', task)
		await scheduleHousekeeping(unavailable.app, 'Test prune', task)
		await vi.advanceTimersByTimeAsync(housekeepingIntervalMs + housekeepingJitterMs)

		// Assert
		expect(task).not.toHaveBeenCalled()
		expect(memory.app.addHook).not.toHaveBeenCalled()
	})
})
