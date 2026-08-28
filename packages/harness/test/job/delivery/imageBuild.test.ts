import { BatchGetBuildsCommand, StartBuildCommand } from '@aws-sdk/client-codebuild'

import { createCodeBuildImageBuilder } from '#job/delivery/imageBuild.ts'

import type { CodeBuildClientLike } from '#job/delivery/imageBuildClient.ts'

// MARK: Fixtures

type Sent = { name: string; input: Record<string, unknown> }

/** Records every command; `statuses` is the sequence BatchGetBuilds answers with */
const createStub = ({ statuses = ['SUCCEEDED'] }: { statuses?: string[] } = {}) => {
	const sent: Sent[] = []
	let polls = 0
	const send = async (command: { constructor: unknown; input: Record<string, unknown> }) => {
		sent.push({ name: (command.constructor as { name: string }).name, input: command.input })
		if (command instanceof StartBuildCommand) return { build: { id: 'build-1' } }
		if (command instanceof BatchGetBuildsCommand) {
			const buildStatus = statuses[Math.min(polls, statuses.length - 1)]
			polls += 1
			return { builds: [{ id: 'build-1', buildStatus }] }
		}
		throw new Error('unexpected command')
	}
	const client = { send } as unknown as CodeBuildClientLike
	return { client, sent }
}

const names = (sent: Sent[]) => sent.map(entry => entry.name)

// MARK: Tests

describe('CodeBuild image builder', () => {
	it('Starts a build with the ECR repo + image tag overrides and returns the pushed image URI', async () => {
		// Arrange
		const { client, sent } = createStub({ statuses: ['IN_PROGRESS', 'SUCCEEDED'] })
		const sleep = vi.fn(async () => {})
		const builder = createCodeBuildImageBuilder({
			project: 'mf-delivery-build-dev',
			ecrRepositoryUri: 'acct.dkr.ecr.eu-north-1.amazonaws.com/mf-deliverables-dev',
			client,
			sleep,
		})

		// Act
		const { imageUri } = await builder.build({ imageTag: 'mf-11111111-gym' })

		// Assert
		expect(imageUri).toBe(
			'acct.dkr.ecr.eu-north-1.amazonaws.com/mf-deliverables-dev:mf-11111111-gym'
		)
		expect(names(sent)).toEqual([
			'StartBuildCommand',
			'BatchGetBuildsCommand',
			'BatchGetBuildsCommand',
		])
		expect(sent[0]!.input).toMatchObject({
			projectName: 'mf-delivery-build-dev',
			environmentVariablesOverride: [
				{ name: 'ECR_REPOSITORY_URI', value: 'acct.dkr.ecr.eu-north-1.amazonaws.com/mf-deliverables-dev' },
				{ name: 'IMAGE_TAG', value: 'mf-11111111-gym' },
			],
		})
		expect(sleep).toHaveBeenCalledTimes(1)
	})

	it('Fails the build when CodeBuild reaches a non-SUCCEEDED terminal status', async () => {
		// Arrange
		const { client } = createStub({ statuses: ['IN_PROGRESS', 'FAILED'] })
		const builder = createCodeBuildImageBuilder({
			project: 'p',
			ecrRepositoryUri: 'r',
			client,
			sleep: async () => {},
		})

		// Act + Assert
		await expect(builder.build({ imageTag: 't' })).rejects.toThrow('CodeBuild build-1 finished FAILED')
	})

	it('Stops polling as soon as the signal aborts', async () => {
		// Arrange
		const { client, sent } = createStub({ statuses: ['IN_PROGRESS'] })
		const controller = new AbortController()
		const builder = createCodeBuildImageBuilder({
			project: 'p',
			ecrRepositoryUri: 'r',
			client,
			pollIntervalMs: 60_000,
		})

		// Act
		const pending = builder.build({ imageTag: 't', signal: controller.signal })
		await vi.waitFor(() => expect(names(sent)).toContain('BatchGetBuildsCommand'))
		controller.abort()

		// Assert
		await expect(pending).rejects.toThrow('aborted')
		expect(names(sent).filter(name => name === 'BatchGetBuildsCommand')).toHaveLength(1)
	})
})
