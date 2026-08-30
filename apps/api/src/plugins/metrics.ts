import fp from 'fastify-plugin'
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch'

import type { StandardUnit } from '@aws-sdk/client-cloudwatch'
import type { FastifyPluginAsync } from 'fastify'

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * Tamper-proof job metrics for the CloudWatch alarms in `infra/lib/ops-stack.ts` (M3
		 * hardening #2). Called only from `jobService`'s trusted, Zod-validated report-ingestion
		 * path — never derived from raw job container log lines, which a customer's own build
		 * script output can also print and so spoof. Publishing never fails a report: a
		 * CloudWatch error is logged and swallowed.
		 */
		metrics: {
			/** A job's `reportUpdate` moved it to `status: 'failed'` */
			recordJobFailed: (jobId: string) => Promise<void>
			/** The running (or final) token total on a job's `reportUpdate` */
			recordJobTokensUsed: (jobId: string, tokensUsed: number) => Promise<void>
		}
	}
}

/** Matches the `mf/<env>` namespace the alarms in `infra/lib/ops-stack.ts` read */
const namespaceOf = (env: string) => `mf/${env}`

const plugin: FastifyPluginAsync = async app => {
	const namespace = namespaceOf(app.secrets.env)
	const client = new CloudWatchClient({})
	app.addHook('onClose', async () => client.destroy())

	const putMetric = async (metricName: string, value: number, unit: StandardUnit, jobId: string) => {
		try {
			await client.send(
				new PutMetricDataCommand({
					Namespace: namespace,
					MetricData: [{ MetricName: metricName, Value: value, Unit: unit }],
				})
			)
		} catch (error) {
			app.log.warn({ err: error, jobId, metricName }, 'Could not publish job metric')
		}
	}

	app.decorate('metrics', {
		recordJobFailed: jobId => putMetric('JobsFailed', 1, 'Count', jobId),
		recordJobTokensUsed: (jobId, tokensUsed) => putMetric('JobTokensUsed', tokensUsed, 'None', jobId),
	})
}

export default fp(plugin, { name: '#internal/metrics', dependencies: ['#internal/secrets'] })
