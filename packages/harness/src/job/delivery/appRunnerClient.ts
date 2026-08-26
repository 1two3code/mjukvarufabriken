import type { AppRunnerClient } from '@aws-sdk/client-apprunner'

/** The one method of `AppRunnerClient` the deploy client uses — stubbed in tests */
export type AppRunnerClientLike = Pick<AppRunnerClient, 'send'>
