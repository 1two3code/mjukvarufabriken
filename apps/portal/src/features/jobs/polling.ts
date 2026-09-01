import type { Job, JobStatus } from '@mf/models'

/** How often a live job's row is re-read while the page is open */
export const jobPollingIntervalMs = 3000

/** Statuses a job never leaves — once here, nothing more will happen server-side */
export const terminalJobStatus = ['delivered', 'failed', 'killed'] as const

/**
 * Whether the page should keep polling this job. Deliberately "not terminal" rather than
 * `isActiveJobStatus`: a job that is parked rather than running — the W9 approve-before-deliver
 * hold today, any future waiting state tomorrow — must still live-update, and only the three
 * terminal statuses are a reason to stop asking. `isActiveJobStatus` stays what it is: it also
 * guards the one-active-job-per-order check and the liveness sweep on the api side.
 */
export const isPollableJobStatus = (status: JobStatus) =>
	!(terminalJobStatus as readonly string[]).includes(status)

/**
 * The freshest status we know about the latest job. The order's job list is fetched once and is
 * not polled, so its row freezes at whatever the status was when the page mounted; the polled
 * detail row is the one that actually moves. Without this the page either keeps polling a job
 * that finished long ago, or (after a kill) shows a stale row.
 */
export const latestJobStatus = (job?: Job, jobs?: Job[]): JobStatus | undefined =>
	job?.status ?? jobs?.[0]?.status

/** Poll interval for the job detail query: 0 stops the poll (RTK Query's "no polling"). */
export const jobPollingInterval = (job?: Job, jobs?: Job[]): number => {
	const status = latestJobStatus(job, jobs)
	return status && isPollableJobStatus(status) ? jobPollingIntervalMs : 0
}
