import fp from 'fastify-plugin'
import { ECSClient, RunTaskCommand, StopTaskCommand } from '@aws-sdk/client-ecs'

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
			 * only credential the sandbox gets and it is never logged.
			 */
			runJob: (jobId: string, reportToken: string) => Promise<string | undefined>
			stopTask: (taskArn: string, reason: string) => Promise<void>
		}
	}
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
		})
		return
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
	})
}

export default fp(plugin, { name: '#internal/ecs', dependencies: ['#internal/secrets'] })
