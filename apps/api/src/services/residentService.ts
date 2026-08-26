import fp from 'fastify-plugin'

import type { FastifyPluginAsync } from 'fastify'
import type { ResidentUsageRecord } from '@mf/models'

export class ResidentUnauthorized extends Error {
	constructor() {
		super('Unknown resident installation token')
	}
}

/** Bearer → installation id (`RESIDENT_INSTALLATIONS`, see the `secrets` plugin) */
export const installationOf = (
	installations: Record<string, string>,
	token: string | undefined
) => {
	if (!token) return undefined
	return Object.entries(installations).find(([, value]) => value === token)?.[0]
}

/** `installationId/day` — a day reported twice replaces the earlier record */
export const usageRecordId = (record: Pick<ResidentUsageRecord, 'installationId' | 'day'>) =>
	`${record.installationId}/${record.day}`

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * M8 metering stub: resident installations in customers' accounts POST one usage record
		 * per day (`/internal/resident/usage`); the records are kept here until m6-orders turns
		 * them into Stripe usage-based billing. In-memory for now — a `resident_usage` table is
		 * the next step, not part of this stream.
		 */
		residentService: {
			/** Resolves the bearer to an installation id, or throws `ResidentUnauthorized` */
			authenticate: (token: string | undefined) => Promise<string>
			/** Stores (or replaces) the record; the id is `installationId/day` */
			recordUsage: (record: ResidentUsageRecord) => Promise<{ id: string; stored: true }>
			/** Records of one installation (or all), newest day first */
			listUsage: (installationId?: string) => Promise<ResidentUsageRecord[]>
		}
	}
}

const plugin: FastifyPluginAsync = async app => {
	const { secrets } = app
	const records = new Map<string, ResidentUsageRecord>()

	app.decorate('residentService', {
		authenticate: async token => {
			const installationId = installationOf(secrets.residentInstallations, token)
			if (!installationId) throw new ResidentUnauthorized()
			return installationId
		},
		recordUsage: async record => {
			const id = usageRecordId(record)
			records.set(id, structuredClone(record))
			app.log.info(
				{
					installationId: record.installationId,
					day: record.day,
					totalTokens: record.totalTokens,
					billableUsd: record.cost.billableUsd,
				},
				'resident usage recorded'
			)
			return { id, stored: true }
		},
		listUsage: async installationId =>
			[...records.values()]
				.filter(record => !installationId || record.installationId === installationId)
				.toSorted((a, b) => b.day.localeCompare(a.day)),
	})
}

export default fp(plugin, {
	name: '#internal/residentService',
	dependencies: ['#internal/secrets'],
})
