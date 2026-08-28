import fp from 'fastify-plugin'
import { DescribeTasksCommand, ECSClient, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs'

import type { FastifyPluginAsync } from 'fastify'

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * Starts/stops build-job tasks on the `mf-jobs-<env>` Fargate cluster. `configured` is
		 * false without the CDK-provided cluster/task/subnet settings — `runJob` then returns
		 * undefined and the caller logs the local `job:dev` command instead. When configured,
		 * `runJob` always resolves to a task ARN or throws.
		 */
		ecs: {
			configured: boolean
			/**
			 * Runs the job task definition with `JOB_ID`, the per-job `JOB_TOKEN`, `API_URL` (and
			 * `NO_PROXY` when configured) overridden; resolves to the task ARN. The token is the
			 * only credential the sandbox gets. The api never logs it, but a RunTask override is
			 * visible to `ecs:DescribeTasks` and recorded by CloudTrail — which is why it is a
			 * bootstrap token the job exchanges once (`POST /internal/jobs/:id/token`) before any
			 * worker runs.
			 */
			runJob: (jobId: string, reportToken: string) => Promise<string | undefined>
			stopTask: (taskArn: string, reason: string) => Promise<void>
			/**
			 * `ecs:DescribeTasks` for the given task ARNs, keyed by ARN. A task ECS no longer
			 * knows about (stopped tasks age out of DescribeTasks after ~1h) is simply absent
			 * from the map — the liveness sweep reads that, and a `STOPPED` `lastStatus`, as a
			 * dead task. ARNs are chunked to the 100-per-call DescribeTasks limit.
			 */
			describeTasks: (taskArns: string[]) => Promise<Map<string, TaskState>>
		}
	}
}

/** The slice of an ECS task the liveness sweep reads */
export type TaskState = {
	/** `PROVISIONING` | `PENDING` | `RUNNING` | `DEPROVISIONING` | `STOPPING` | `STOPPED` | … */
	lastStatus: string
	/** ECS's reason a task stopped, when it stopped (e.g. `Essential container in task exited`) */
	stoppedReason?: string
}

/** DescribeTasks accepts at most 100 tasks per call */
export const describeTasksChunk = 100

const chunk = <T>(items: T[], size: number): T[][] => {
	const chunks: T[][] = []
	for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
	return chunks
}

/** Container name in the job task definition (see infra/lib/resources-stack.ts) */
export const jobContainerName = 'job'

const plugin: FastifyPluginAsync = async app => {
	const {
		jobsClusterArn,
		jobTaskDefinitionArn,
		jobSubnetIds,
		jobSecurityGroupId,
		jobApiUrl,
		jobNoProxy,
	} = app.secrets.infra
	const configured = Boolean(
		jobsClusterArn && jobTaskDefinitionArn && jobSubnetIds.length && jobSecurityGroupId
	)

	if (!configured) {
		app.log.warn('ECS not configured — jobs are inserted but must be run with `npm run job:dev`')
		app.decorate('ecs', {
			configured: false,
			runJob: async () => undefined,
			stopTask: async () => {},
			describeTasks: async () => new Map(),
		})
		return
	}

	// Without a custom domain the ALB has no certificate and JOB_API_URL is plain http: every
	// report (bearer token, spec, events) would cross NAT → public ALB unencrypted. Loud, not
	// fatal — the cert is a TODO-EXTERNAL item and the token is one-shot + per-job.
	if (!jobApiUrl.startsWith('https://')) {
		app.log.warn({ jobApiUrl }, 'JOB_API_URL is not https — build jobs report in cleartext')
	}

	const client = new ECSClient({})
	app.addHook('onClose', async () => client.destroy())

	app.decorate('ecs', {
		configured: true,
		runJob: async (jobId, reportToken) => {
			const environment = [
				{ name: 'JOB_ID', value: jobId },
				{ name: 'JOB_TOKEN', value: reportToken },
				{ name: 'API_URL', value: jobApiUrl },
				...(jobNoProxy ? [{ name: 'NO_PROXY', value: jobNoProxy }] : []),
			]
			const result = await client.send(
				new RunTaskCommand({
					cluster: jobsClusterArn,
					taskDefinition: jobTaskDefinitionArn,
					launchType: 'FARGATE',
					count: 1,
					startedBy: `mf-api-${app.secrets.env}`,
					networkConfiguration: {
						awsvpcConfiguration: {
							subnets: jobSubnetIds,
							securityGroups: [jobSecurityGroupId!],
							assignPublicIp: 'DISABLED',
						},
					},
					overrides: {
						containerOverrides: [{ name: jobContainerName, environment }],
					},
				})
			)
			const failure = result.failures?.[0]
			if (failure) throw new Error(`ecs:RunTask failed: ${failure.reason} (${failure.detail})`)
			const taskArn = result.tasks?.[0]?.taskArn
			// An empty response would otherwise leave the job queued forever with no signal
			if (!taskArn) throw new Error('ecs:RunTask returned no task and no failure')
			return taskArn
		},
		stopTask: async (taskArn, reason) => {
			await client.send(new StopTaskCommand({ cluster: jobsClusterArn, task: taskArn, reason }))
		},
		describeTasks: async taskArns => {
			const states = new Map<string, TaskState>()
			for (const tasks of chunk(taskArns, describeTasksChunk)) {
				if (!tasks.length) continue
				const result = await client.send(
					new DescribeTasksCommand({ cluster: jobsClusterArn, tasks })
				)
				for (const task of result.tasks ?? []) {
					if (!task.taskArn || !task.lastStatus) continue
					states.set(task.taskArn, {
						lastStatus: task.lastStatus,
						stoppedReason: task.stoppedReason,
					})
				}
			}
			return states
		},
	})
}

export default fp(plugin, { name: '#internal/ecs', dependencies: ['#internal/secrets'] })
