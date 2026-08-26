import type { FastifyInstance } from 'fastify'

/** Housekeeping runs at boot and then about once an hour */
export const housekeepingIntervalMs = 60 * 60 * 1000
/** Each run is delayed by a random 0–5 min so api tasks started together do not all prune at once */
export const housekeepingJitterMs = 5 * 60 * 1000

/**
 * Runs `task` now and then every `housekeepingIntervalMs` (+ jitter) until the app closes — only
 * on Postgres: the memory repositories are process-local, self-sweeping and gone on restart.
 * Failures are logged, never fatal; a run that throws does not stop the schedule.
 */
export const scheduleHousekeeping = async (
	app: FastifyInstance,
	name: string,
	task: () => Promise<void>
) => {
	if (app.db.backend !== 'postgres' || !app.db.available) return

	const run = () => task().catch((error: Error) => app.log.warn({ err: error }, `${name} failed`))

	let timer: NodeJS.Timeout | undefined
	const next = () => {
		timer = setTimeout(
			() => void run().finally(next),
			housekeepingIntervalMs + Math.random() * housekeepingJitterMs
		)
		timer.unref()
	}

	await run()
	next()
	app.addHook('onClose', () => clearTimeout(timer))
}
