import type { ECRClient } from '@aws-sdk/client-ecr'
import type { OrganizationsClient } from '@aws-sdk/client-organizations'
import type { ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api'
import type { S3Client } from '@aws-sdk/client-s3'
import type { STSClient } from '@aws-sdk/client-sts'

/**
 * The AWS clients this module talks to, narrowed to the one method we call (`send`). Production
 * passes a real client; tests pass `{ send }` fakes cast to these — nothing here ever news up a
 * real client, so there is no path to a real AWS call from a test.
 */
export type OrganizationsClientLike = Pick<OrganizationsClient, 'send'>
export type StsClientLike = Pick<STSClient, 'send'>
export type TaggingClientLike = Pick<ResourceGroupsTaggingAPIClient, 'send'>
export type S3ClientLike = Pick<S3Client, 'send'>
export type EcrClientLike = Pick<ECRClient, 'send'>
