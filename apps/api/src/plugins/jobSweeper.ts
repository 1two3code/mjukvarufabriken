import fp from 'fastify-plugin'

import { scheduleHousekeeping } from '#/lib/housekeeping.ts'
import { runJobSweep } from '#/lib/jobSweep.ts'

import type { FastifyPluginAsync } from 'fastify'

/**
 * Job liveness sweep (M9): a build job whose Fargate task dies before it claims its report token
 * would otherwise stay `queued` forever. Shortly after boot and then hourly (the shared
 * housekeeping schedule — Postgres only, jitter, cleared on close) this `ecs:DescribeTasks` for
 * every active job's task and marks the job `failed` when its task is `STOPPED` or gone.
 */
const plugin: FastifyPluginAsync = async app => {
	scheduleHousekeeping(app, 'Job liveness sweep', async () => {
		await runJobSweep(app)
	})
}

export default fp(plugin, {
	name: '#internal/jobSweeper',
	dependencies: ['#internal/db', '#internal/ecs'],
})
