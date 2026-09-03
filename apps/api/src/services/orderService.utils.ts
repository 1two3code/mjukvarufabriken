import { DeliveryEventPayloadSchema } from '@mf/models'

import { deliverableFromEvents } from '#/services/jobService.ts'

import type { Job, JobEvent, JobSummary, OrderHosting } from '@mf/models'

export const toJobSummary = (job: Job): JobSummary => ({
	id: job.id,
	status: job.status,
	mode: job.mode,
	sourceJobId: job.sourceJobId,
	reason: job.reason,
	tokensUsed: job.tokensUsed,
	budget: job.budget,
	startedAt: job.startedAt,
	finishedAt: job.finishedAt,
	createdAt: job.createdAt,
})

/** The newest job that delivered — the one whose deliverable says what the customer has */
export const latestDeliveredJob = (jobs: Job[]) => jobs.find(job => job.status === 'delivered')

/**
 * Why the preview URL was withheld: the reason of the LAST failed `deploy` or `acceptance`
 * delivery event (the deploy step emits a failure when it is skipped or errors; the acceptance
 * step when the live app is judged broken). Undefined when no such event exists.
 */
const withheldReasonFromEvents = (events: JobEvent[]) => {
	for (const event of events.toReversed()) {
		if (event.type !== 'delivery') continue
		const parsed = DeliveryEventPayloadSchema.safeParse(event.payload)
		if (!parsed.success || parsed.data.ok) continue
		if (parsed.data.step === 'deploy' || parsed.data.step === 'acceptance') {
			return parsed.data.reason
		}
	}
	return undefined
}

/**
 * What the customer actually got (wave 14, F7). `live` when the latest delivered job's
 * deliverable carries a preview URL; `unhosted` when a job delivered (repo + bundle honoured)
 * but the URL is null — the reason is the job's own `reason` (forwarded by the harness since
 * this wave) or, for older rows, the failed deploy/acceptance step's; `none` before any delivery.
 */
export const hostingOf = (delivered: Job | undefined, events: JobEvent[]): OrderHosting => {
	if (!delivered) return { status: 'none', deployUrl: null, reason: null }
	const deliverable = deliverableFromEvents(events)
	if (deliverable?.deployUrl) {
		return { status: 'live', deployUrl: deliverable.deployUrl, reason: null }
	}
	return {
		status: 'unhosted',
		deployUrl: null,
		reason: delivered.reason ?? withheldReasonFromEvents(events) ?? null,
	}
}
