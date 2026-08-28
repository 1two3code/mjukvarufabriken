import type { ECSClient } from '@aws-sdk/client-ecs'

/** The one method of `ECSClient` the Express deploy client uses — stubbed in tests */
export type EcsClientLike = Pick<ECSClient, 'send'>
