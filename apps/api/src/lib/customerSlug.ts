import { appNameOf, customerTagValue, previewServiceName, slugify } from '@mf/harness'

import type { Org } from '@mf/models'

/**
 * The `Customer=<slug>` fence value delivery stamps on this build's ECS Express service, computed
 * from the SAME app-name / job derivation `apps/job` uses to name the service
 * (`mf-<job8>-<slug>`) and then run back through `customerTagValue` (@mf/harness), which is what
 * `packages/harness/.../ecsExpress.ts` derives the tag from. Keeping this one function as the
 * single source means the value stored on the order (set at build start) always equals the tag the
 * live service carries, so the admin lifecycle action fences @mf/org `deprovision` to exactly the
 * resources this build created.
 *
 * NOTE: mirrors `apps/job/src/index.ts`'s `slug = ${slugify(appName).slice(0,50)}-${job8}`; the
 * two must stay in step (both go through the exported harness helpers to keep drift minimal).
 */
export const customerSlugForBuild = (goal: string, jobId: string): string => {
	const appName = appNameOf(goal)
	const deliverySlug = `${slugify(appName).slice(0, 50)}-${jobId.slice(0, 8)}`
	return customerTagValue(previewServiceName(jobId, deliverySlug))
}

/**
 * The customer slug an org's AWS account is vended under (`mf-customer-<slug>`). Derived from the
 * org name and normalised to a valid @mf/org `SlugSchema` value (lowercase, 2–40 chars); a
 * degenerate name falls back to the org id so a slug is always producible.
 */
export const customerSlugForOrg = (org: Pick<Org, 'id' | 'name'>): string => {
	const fromName = slugify(org.name)
		.slice(0, 40)
		.replace(/-+$/g, '')
	if (fromName.length >= 2) return fromName
	return `org-${org.id.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 36)}`.slice(0, 40)
}
