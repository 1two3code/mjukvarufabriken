import { DeliveryEventPayloadSchema, deliveryStep, isActiveJobStatus } from '@mf/models'

import type { DeliveryStep, Job, JobEvent } from '@mf/models'

// MARK: Delivery timeline

export type DeliveryStepState = {
	step: DeliveryStep
	/** `pending` = the step has not reported (yet, or ever — the delivery stopped before it) */
	state: 'ok' | 'failed' | 'pending'
	reason?: string
	url?: string
}

/**
 * One row per delivery step in run order, judged by the LAST `delivery` event of that step (a
 * step may report twice — e.g. deploy → acceptance fails → the bundle still lands). Steps with
 * no event are `pending`; a job that never reached delivery has every step pending.
 */
export const deliveryTimeline = (events: JobEvent[]): DeliveryStepState[] => {
	const latest = new Map<DeliveryStep, DeliveryStepState>()
	for (const event of events) {
		if (event.type !== 'delivery') continue
		const parsed = DeliveryEventPayloadSchema.safeParse(event.payload)
		if (!parsed.success) continue
		const { step, ok, reason, url } = parsed.data
		latest.set(step, { step, state: ok ? 'ok' : 'failed', reason, url })
	}
	return deliveryStep.map(step => latest.get(step) ?? { step, state: 'pending' })
}

/** True once any delivery step has reported — the timeline has something to show */
export const hasDeliverySteps = (timeline: DeliveryStepState[]) =>
	timeline.some(step => step.state !== 'pending')

// MARK: Job outcome

export type JobOutcomeKind = 'running' | 'live' | 'unhosted' | 'delivered' | 'failed' | 'killed'

export type JobOutcome = {
	kind: JobOutcomeKind
	/** The live preview URL (`live`) */
	url?: string
	/** Why the build failed / was killed / has no preview */
	reason?: string
}

/**
 * What a job amounted to, for a list row. `deployUrl` is the deliverable's, when the caller has
 * loaded it: a string makes the job `live`, null `unhosted`. Without it (undefined) a delivered
 * job with a reason is still `unhosted` — the harness forwards the withheld-URL reason onto the
 * row — and one without is plain `delivered`: honest about the repo, silent about hosting,
 * never a claim that the site is live.
 */
export const jobOutcome = (
	job: Pick<Job, 'status' | 'reason'>,
	deployUrl?: string | null
): JobOutcome => {
	if (isActiveJobStatus(job.status)) return { kind: 'running' }
	if (job.status === 'failed' || job.status === 'killed') {
		return { kind: job.status, reason: job.reason }
	}
	if (deployUrl) return { kind: 'live', url: deployUrl }
	if (deployUrl === null || job.reason) return { kind: 'unhosted', reason: job.reason }
	return { kind: 'delivered' }
}
