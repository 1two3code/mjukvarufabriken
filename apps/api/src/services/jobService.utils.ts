import { DeliveryEventPayloadSchema } from '@mf/models'

import type { Deliverable, Job, JobEvent } from '@mf/models'

/**
 * Which job the preview resources belong to: a redelivery reuses its SOURCE job's database,
 * storage role and Express service (deterministic names), so a retry of the hosting side never
 * mints a second set the customer's app would not be pointed at.
 */
export const provisioningJobIdOf = (job: Job) =>
	job.mode === 'redeliver' && job.sourceJobId ? job.sourceJobId : job.id

/**
 * The delivery record lives in the last successful `bundle` delivery event (the job writes
 * events only; no job column for it). Undefined until the job delivered.
 *
 * A `.utils.ts` companion so other services (the showcase gallery resolving an order's live
 * URL) can share the one parser without importing `jobService.ts` itself — which the test
 * harness replaces with its `__mocks__` twin, where this function would not exist.
 */
export const deliverableFromEvents = (events: JobEvent[]): Deliverable | undefined => {
	for (const event of events.toReversed()) {
		if (event.type !== 'delivery') continue
		const parsed = DeliveryEventPayloadSchema.safeParse(event.payload)
		if (
			parsed.success &&
			parsed.data.step === 'bundle' &&
			parsed.data.ok &&
			parsed.data.deliverable
		) {
			return parsed.data.deliverable
		}
	}
	return undefined
}
