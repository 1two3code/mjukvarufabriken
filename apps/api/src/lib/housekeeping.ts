import type { FastifyInstance } from 'fastify'

/** Housekeeping runs shortly after boot and then about once an hour */
export const housekeepingIntervalMs = 60 * 60 * 1000
/** Each run is delayed by a random 0–5 min so api tasks started together do not all prune at once */
export const housekeepingJitterMs = 5 * 60 * 1000
/**
 * The first run waits a little (plus jitter) instead of running inside plugin registration, so a
 * slow delete on a bloated table never holds up `app.ready()` and the ALB health checks.
 */
export const housekeepingBootDelayMs = 30 * 1000

/**
 * Runs `task` shortly after boot and then every `housekeepingIntervalMs` (+ jitter) until the app
 * closes — only on Postgres: the memory repositories are process-local, sweep themselves on
 * insert and are gone on restart. Failures are logged, never fatal; a run that throws does not
 * stop the schedule. Nothing is awaited here: registration never waits for the database.
 */
export const scheduleHousekeeping = (
	app: FastifyInstance,
	name: string,
	task: () => Promise<void>
) => {
	if (app.db.backend !== 'postgres' || !app.db.available) return

	const run = () => task().catch((error: Error) => app.log.warn({ err: error }, `${name} failed`))

	let closed = false
	let timer: NodeJS.Timeout | undefined
	const arm = (delayMs: number) => {
		// A run in flight when the app closed must not re-arm against a closed pool
		if (closed) return
		timer = setTimeout(() => {
			void run().finally(() => arm(housekeepingIntervalMs + Math.random() * housekeepingJitterMs))
		}, delayMs)
		timer.unref()
	}

	arm(housekeepingBootDelayMs + Math.random() * housekeepingJitterMs)
	app.addHook('onClose', () => {
		closed = true
		clearTimeout(timer)
	})
}
