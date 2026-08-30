import type { CodeBuildClient } from '@aws-sdk/client-codebuild'

/** The one method of `CodeBuildClient` the image builder uses — stubbed in tests */
export type CodeBuildClientLike = Pick<CodeBuildClient, 'send'>
