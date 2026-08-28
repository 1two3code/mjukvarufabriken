import { describeTasksChunk, jobContainerName } from '#/plugins/ecs.ts'

// Clearly mocked: no real AWS calls are made in this suite.
const sendMock = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-ecs', () => ({
	ECSClient: class {
		send = sendMock
		destroy = vi.fn()
	},
	RunTaskCommand: class {
		input: unknown
		constructor(input: unknown) {
			this.input = input
		}
	},
	StopTaskCommand: class {
		input: unknown
		constructor(input: unknown) {
			this.input = input
		}
	},
	DescribeTasksCommand: class {
		input: unknown
		constructor(input: unknown) {
			this.input = input
		}
	},
}))

const cluster = 'arn:aws:ecs:eu-north-1:1:cluster/mf-jobs-test'
const taskDefinition = 'arn:aws:ecs:eu-north-1:1:task-definition/mf-job-test:3'

/** Real secrets + ecs plugins; everything else mocked */
const createApp = async (configured: boolean) => {
	vi.stubEnv('AUTH_AUDIENCE', 'audience')
	vi.stubEnv('ANTHROPIC_API_KEY', '')
	vi.stubEnv('ANTHROPIC_API_KEY_SECRET_ARN', '')
	vi.stubEnv('AUTH_JWT_PRIVATE_KEY_SECRET_ARN', '')
	vi.stubEnv('JOBS_CLUSTER_ARN', configured ? cluster : '')
	vi.stubEnv('JOB_TASK_DEFINITION_ARN', configured ? taskDefinition : '')
	vi.stubEnv('JOB_SUBNET_IDS', configured ? 'subnet-a,subnet-b' : '')
	vi.stubEnv('JOB_SECURITY_GROUP_ID', configured ? 'sg-1' : '')
	vi.stubEnv('JOB_API_URL', 'http://alb.internal')
	vi.stubEnv('JOB_NO_PROXY', 'localhost,alb.internal')
	vi.doUnmock('#/plugins/secrets.ts')
	vi.resetModules()
	return createTestApp({ skipMock: ['#/plugins/ecs.ts', '#/plugins/secrets.ts'] })
}

describe('ECS plugin (ecs)', () => {
	beforeEach(() => sendMock.mockReset())
	afterEach(() => vi.unstubAllEnvs())

	it('Is unconfigured without cluster settings and returns no task ARN', async () => {
		// Arrange
		const app = await createApp(false)

		// Act
		const taskArn = await app.ecs.runJob('job-1', 'token')

		// Assert
		expect(app.ecs.configured).toBe(false)
		expect(taskArn).toBeUndefined()
		expect(sendMock).not.toHaveBeenCalled()
	})

	it('Runs the job task with JOB_ID, JOB_TOKEN, API_URL and NO_PROXY overrides in the private subnets', async () => {
		// Arrange
		const app = await createApp(true)
		sendMock.mockResolvedValue({ tasks: [{ taskArn: 'arn:task/1' }], failures: [] })

		// Act
		const taskArn = await app.ecs.runJob('job-1', 'secret-token')

		// Assert
		expect(app.ecs.configured).toBe(true)
		expect(taskArn).toBe('arn:task/1')
		const { input } = sendMock.mock.calls[0]![0]
		expect(input).toMatchObject({
			cluster,
			taskDefinition,
			launchType: 'FARGATE',
			networkConfiguration: {
				awsvpcConfiguration: {
					subnets: ['subnet-a', 'subnet-b'],
					securityGroups: ['sg-1'],
					assignPublicIp: 'DISABLED',
				},
			},
			overrides: {
				containerOverrides: [
					{
						name: jobContainerName,
						environment: [
							{ name: 'JOB_ID', value: 'job-1' },
							{ name: 'JOB_TOKEN', value: 'secret-token' },
							{ name: 'API_URL', value: 'http://alb.internal' },
							{ name: 'NO_PROXY', value: 'localhost,alb.internal' },
						],
					},
				],
			},
		})
	})

	it('Throws when RunTask reports a failure', async () => {
		// Arrange
		const app = await createApp(true)
		sendMock.mockResolvedValue({
			tasks: [],
			failures: [{ reason: 'RESOURCE:CPU', detail: 'no capacity' }],
		})

		// Act / Assert
		await expect(app.ecs.runJob('job-1', 'token')).rejects.toThrow(/RESOURCE:CPU/)
	})

	it('Throws when RunTask returns neither a task nor a failure', async () => {
		// Arrange
		const app = await createApp(true)
		sendMock.mockResolvedValue({ tasks: [], failures: [] })

		// Act / Assert
		await expect(app.ecs.runJob('job-1', 'token')).rejects.toThrow(/no task and no failure/)
	})

	it('Stops a task on the cluster', async () => {
		// Arrange
		const app = await createApp(true)
		sendMock.mockResolvedValue({})

		// Act
		await app.ecs.stopTask('arn:task/1', 'killed by admin')

		// Assert
		expect(sendMock.mock.calls[0]![0].input).toEqual({
			cluster,
			task: 'arn:task/1',
			reason: 'killed by admin',
		})
	})

	it('describeTasks maps task states by ARN and carries the stopped reason', async () => {
		// Arrange
		const app = await createApp(true)
		sendMock.mockResolvedValue({
			tasks: [
				{ taskArn: 'arn:task/1', lastStatus: 'RUNNING' },
				{ taskArn: 'arn:task/2', lastStatus: 'STOPPED', stoppedReason: 'exit 1' },
				// A task with no lastStatus is skipped rather than mapped as alive
				{ taskArn: 'arn:task/x' },
			],
			failures: [{ arn: 'arn:task/3', reason: 'MISSING' }],
		})

		// Act
		const states = await app.ecs.describeTasks(['arn:task/1', 'arn:task/2', 'arn:task/3'])

		// Assert: the describe hit the right cluster and only known tasks are mapped
		expect(sendMock.mock.calls[0]![0].input).toEqual({
			cluster,
			tasks: ['arn:task/1', 'arn:task/2', 'arn:task/3'],
		})
		expect(states.get('arn:task/1')).toEqual({ lastStatus: 'RUNNING', stoppedReason: undefined })
		expect(states.get('arn:task/2')).toEqual({ lastStatus: 'STOPPED', stoppedReason: 'exit 1' })
		expect(states.has('arn:task/x')).toBe(false)
		// A MISSING task (aged out of ECS) is simply absent — the sweep reads that as dead
		expect(states.has('arn:task/3')).toBe(false)
	})

	it('describeTasks chunks ARNs to the DescribeTasks per-call limit', async () => {
		// Arrange
		const app = await createApp(true)
		const arns = Array.from({ length: describeTasksChunk + 5 }, (_, i) => `arn:task/${i}`)
		sendMock.mockResolvedValue({
			tasks: arns.map(taskArn => ({ taskArn, lastStatus: 'RUNNING' })),
			failures: [],
		})

		// Act
		const states = await app.ecs.describeTasks(arns)

		// Assert: two DescribeTasks calls, split 100 + 5, and every ARN mapped to a state
		expect(sendMock).toHaveBeenCalledTimes(2)
		expect(sendMock.mock.calls[0]![0].input.tasks).toHaveLength(describeTasksChunk)
		expect(sendMock.mock.calls[1]![0].input.tasks).toHaveLength(5)
		expect(states.size).toBe(describeTasksChunk + 5)
	})

	it('describeTasks on the unconfigured plugin returns an empty map without calling AWS', async () => {
		// Arrange
		const app = await createApp(false)

		// Act
		const states = await app.ecs.describeTasks(['arn:task/1'])

		// Assert
		expect(states.size).toBe(0)
		expect(sendMock).not.toHaveBeenCalled()
	})
})
