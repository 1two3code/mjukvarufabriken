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

/**
 * The reason for a job that outlived its whole wall-clock budget with NO task ever recorded —
 * the launch died between the row insert and the arn update, or the arn write was lost. Even if
 * a task did start, its own duration budget ended it long before this sweep fires.
 */
export const neverLaunchedReason =
	'no build task was ever recorded for the job and its wall-clock budget has long passed'

/** A candidate is dead when ECS reports its task `STOPPED` or no longer knows it at all */
const isDead = (state: TaskState | undefined): boolean => !state || state.lastStatus === 'STOPPED'

/**
 * Fails one genuinely-dead job, idempotently: re-reads the row first and only writes if it is
 * still active (a terminal PATCH from the container, or an admin kill, in the window since the
 * candidate list was taken wins), and treats the killed-guard's `undefined` as "leave it".
 * Returns the failed row, or undefined when the job was left alone.
 */
const failDeadJob = async (
	app: FastifyInstance,
	job: Job,
	reason: string
): Promise<Job | undefined> => {
	const current = await app.db.jobs.get(job.id)
	if (!current || !isActiveJobStatus(current.status)) return undefined
	const failed = await app.db.jobs.update(job.id, {
		status: 'failed',
		reason,
		finishedAt: new Date(),
		// The token dies with the job: a container that somehow still reports is refused (401)
		reportTokenHash: null,
	})
	if (!failed) return undefined // killed by an admin in the meantime — the kill wins
	await app.db.jobs.appendEvent(job.id, { type: 'failed', payload: { reason, sweep: true } })
	app.log.warn({ jobId: job.id, taskArn: job.taskArn, reason }, 'Liveness sweep failed a dead job')
	return failed
}

/**
 * A job the sweep fails died WITHOUT reporting: no container notification ever went out — and
 * for a dead auto-retry the FIRST failure's mail was deliberately held (`reportEvents`) on the
 * promise that the retry would page. Unless a retry job was just started (whose own outcome
 * pages), the sweep is therefore the last chance a human hears about the build at all, so it
 * mails the admins itself. Guarded: the sweep also runs in tests without the email plugin.
 */
const notifySweepFailure = async (app: FastifyInstance, job: Job, reason: string) => {
	const { email, secrets } = app as Partial<FastifyInstance>
	if (!email || !secrets) return
	const subject = `[mf ${secrets.env}] Build job ${job.id} failed (liveness sweep)`
	const text = `Job ${job.id} (order ${job.orderId}) was failed by the liveness sweep — its build task died without reporting.\n\nReason:\n${reason}\n\nNo automatic retry was started for it.`
	for (const to of secrets.authAdminEmails) {
		await email.send({ to, subject, text }).catch((error: Error) => {
			app.log.error({ err: error, jobId: job.id, to }, 'Could not send the sweep failure mail')
		})
	}
}

/**
 * One liveness pass: lists active jobs created over `jobSweepMinTaskAgeMs` ago (enough for their
 * Fargate task to start), `ecs:DescribeTasks` for them in one shot, and fails every job whose
 * task ECS reports `STOPPED` or no longer knows. A job whose task is still `RUNNING`/`PENDING`
 * is left untouched. Candidates with NO recorded task (`listStuck` only surfaces those once
 * their whole wall-clock budget plus slack has passed — the interrupted-launch case) are failed
 * on age alone, without asking ECS. A failed job is offered to the demo auto-retry, exactly like
 * a failure the container reported itself; it counts into the `JobsFailed` alarm metric (the
 * container's own terminal report — the usual metric writer — never came), and when no retry
 * was started the admins are mailed (`notifySweepFailure`). Idempotent (a failed job is no
 * longer active, so a later pass skips it) and a no-op when ECS is unconfigured — then no task
 * was ever launched. Returns the counts (for logs and tests).
 */
export const runJobSweep = async (
	app: FastifyInstance
): Promise<{ checked: number; failed: number }> => {
	if (!app.ecs.configured) return { checked: 0, failed: 0 }

	const olderThan = new Date(Date.now() - jobSweepMinTaskAgeMs)
	const candidates = await app.db.jobs.listStuck(olderThan)
	if (!candidates.length) return { checked: 0, failed: 0 }

	const taskArns = candidates.map(job => job.taskArn).filter((arn): arn is string => Boolean(arn))
	const states = taskArns.length ? await app.ecs.describeTasks(taskArns) : new Map<string, TaskState>()
	// The sweep runs from housekeeping, where jobService is registered; guarded for the tests
	// (and any caller) that exercise the sweep without the service
	const retry = (app as Partial<FastifyInstance>).jobService?.retryFailedBuild

	let failed = 0
	for (const job of candidates) {
		const state = job.taskArn ? states.get(job.taskArn) : undefined
		if (job.taskArn && !isDead(state)) continue
		const reason = job.taskArn ? deadJobReason(state) : neverLaunchedReason
		const failedJob = await failDeadJob(app, job, reason)
		if (!failedJob) continue
		failed++
		await (app as Partial<FastifyInstance>).metrics
			?.recordJobFailed(job.id)
			.catch((error: Error) =>
				app.log.warn({ err: error, jobId: job.id }, 'Could not record the JobsFailed metric')
			)
		let retried: Job | undefined
		let retryThrew = false
		if (retry) {
			try {
				retried = await retry(failedJob)
			} catch (error) {
				// `retryFailedBuild` has already mailed for every post-candidacy throw
				retryThrew = true
				app.log.error({ err: error, jobId: job.id }, 'Auto-retry of the swept job threw')
			}
		}
		if (!retried && !retryThrew) await notifySweepFailure(app, failedJob, reason)
	}

	const result = { checked: candidates.length, failed }
	if (failed) app.log.info(result, 'Job liveness sweep failed dead jobs')
	return result
}
