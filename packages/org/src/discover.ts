import { GetResourcesCommand } from '@aws-sdk/client-resource-groups-tagging-api'

import { SERVICE_TAG } from '#/constants.ts'

import type { DeliveryResource } from '#/schemas.ts'
import type { TaggingClientLike } from '#/types.ts'

/** The AWS service segment of an ARN: `arn:partition:service:region:acct:…` → `service`. */
export const serviceOfArn = (arn: string) => arn.split(':')[2] || 'unknown'

export type DiscoverFilter = {
	/** Extra tags ANDed with the base `Service=mf-delivery` fence, e.g. `{ 'mf:customer': 'acme' }`. */
	tags?: Record<string, string>
}

/** Discovers the tagged resources to act on. Injected into `deprovision` (a fake in tests). */
export type Discover = (filter: DiscoverFilter) => Promise<DeliveryResource[]>

/**
 * Resource-Groups Tagging API discovery: every resource carrying `Service=mf-delivery` (plus any
 * extra tag filters), paginated. Discovery — not a stored inventory — is the source of truth, so a
 * drifted record can never cause us to miss or over-reach a resource.
 */
export const createTaggingDiscovery = (client: TaggingClientLike): Discover => {
	return async filter => {
		const tags = { [SERVICE_TAG.key]: SERVICE_TAG.value, ...filter.tags }
		const tagFilters = Object.entries(tags).map(([Key, value]) => ({ Key, Values: [value] }))
		const resources: DeliveryResource[] = []
		let token: string | undefined
		do {
			const page = await client.send(
				new GetResourcesCommand({ TagFilters: tagFilters, PaginationToken: token })
			)
			for (const mapping of page.ResourceTagMappingList ?? []) {
				if (!mapping.ResourceARN) continue
				const tagMap = Object.fromEntries(
					(mapping.Tags ?? []).flatMap(tag => (tag.Key ? [[tag.Key, tag.Value ?? '']] : []))
				)
				resources.push({
					arn: mapping.ResourceARN,
					service: serviceOfArn(mapping.ResourceARN),
					tags: tagMap,
				})
			}
			// The tagging API signals "done" with an empty-string token, not undefined.
			token = page.PaginationToken || undefined
		} while (token)
		return resources
	}
}
