import { isActiveJobStatus } from '@mf/models'

import type { FastifyInstance } from 'fastify'
import type { Job } from '@mf/models'
import type { TaskState } from '#/plugins/ecs.ts'

/**
 * A launched task gets this long to boot and claim its report token before the sweep will
 * judge it dead — long enough that a task still `PROVISIONING`/`PENDING` (or one whose
 * `RunTask` the api recorded a moment ago) is never mistaken for a crashed one.
 */
export const jobSweepMinTaskAgeMs = 10 * 60 * 1000

/** The reason written on a job the sweep fails, from what ECS says of its task */
export const deadJobReason = (state: TaskState | undefined): string =>
	state
		? `build task stopped (${state.lastStatus})${state.stoppedReason ? `: ${state.stoppedReason}` : ''}`
		: 'build task gone from ECS before the job finished'

/** A candidate is dead when ECS reports its task `STOPPED` or no longer knows it at all */
const isDead = (state: TaskState | undefined): boolean => !state || state.lastStatus === 'STOPPED'

/**
 * Fails one genuinely-dead job, idempotently: re-reads the row first and only writes if it is
 * still active (a terminal PATCH from the container, or an admin kill, in the window since the
 * candidate list was taken wins), and treats the killed-guard's `undefined` as "leave it".
 * Returns whether it actually failed the job.
 */
const failDeadJob = async (
	app: FastifyInstance,
	job: Job,
	state: TaskState | undefined
): Promise<boolean> => {
	const current = await app.db.jobs.get(job.id)
	if (!current || !isActiveJobStatus(current.status)) return false
	const reason = deadJobReason(state)
	const failed = await app.db.jobs.update(job.id, {
		status: 'failed',
		reason,
		finishedAt: new Date(),
		// The token dies with the job: a container that somehow still reports is refused (401)
		reportTokenHash: null,
	})
	if (!failed) return false // killed by an admin in the meantime — the kill wins
	await app.db.jobs.appendEvent(job.id, { type: 'failed', payload: { reason, sweep: true } })
	app.log.warn({ jobId: job.id, taskArn: job.taskArn, reason }, 'Liveness sweep failed a dead job')
	return true
}

/**
 * One liveness pass: lists active jobs whose Fargate task was launched over `jobSweepMinTaskAgeMs`
 * ago, `ecs:DescribeTasks` for them in one shot, and fails every job whose task ECS reports
 * `STOPPED` or no longer knows. A job whose task is still `RUNNING`/`PENDING` is left untouched.
 * Idempotent (a failed job is no longer active, so a later pass skips it) and a no-op when ECS is
 * unconfigured — then no task was ever launched. Returns the counts (for logs and tests).
 */
export const runJobSweep = async (
	app: FastifyInstance
): Promise<{ checked: number; failed: number }> => {
	if (!app.ecs.configured) return { checked: 0, failed: 0 }

	const olderThan = new Date(Date.now() - jobSweepMinTaskAgeMs)
	const candidates = await app.db.jobs.listStuck(olderThan)
	if (!candidates.length) return { checked: 0, failed: 0 }

	const taskArns = candidates.map(job => job.taskArn).filter((arn): arn is string => Boolean(arn))
	const states = await app.ecs.describeTasks(taskArns)

	let failed = 0
	for (const job of candidates) {
		const state = job.taskArn ? states.get(job.taskArn) : undefined
		if (!isDead(state)) continue
		if (await failDeadJob(app, job, state)) failed++
	}

	const result = { checked: candidates.length, failed }
	if (failed) app.log.info(result, 'Job liveness sweep failed dead jobs')
	return result
}
