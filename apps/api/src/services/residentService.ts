import fp from 'fastify-plugin'

import type { FastifyPluginAsync } from 'fastify'
import type {
	ResidentInstallation,
	ResidentInstallationMutation,
	ResidentUsageQuery,
	ResidentUsageRecord,
	ResidentUsageSummary,
} from '@mf/models'

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
		 * M8 metering: resident installations in customers' accounts POST one usage record per
		 * day (`/internal/resident/usage`). The records are persisted (`resident_usage`) and
		 * aggregated per installation and month; `paymentService.billResidentUsage` reports the
		 * month's billable amount to the payment provider.
		 */
		residentService: {
			/** Resolves the bearer to an installation id, or throws `ResidentUnauthorized` */
			authenticate: (token: string | undefined) => Promise<string>
			/** Stores (or replaces) the record; the id is `installationId/day` */
			recordUsage: (record: ResidentUsageRecord) => Promise<{ id: string; stored: true }>
			/** Records of one installation (or all), newest day first */
			listUsage: (installationId?: string) => Promise<ResidentUsageRecord[]>
			/**
			 * One summary per installation and month (newest month first), each with what has
			 * been reported to the payment provider for it so far
			 */
			summarizeUsage: (query?: ResidentUsageQuery) => Promise<ResidentUsageSummary[]>
			/** Every installation the factory has seen or an admin has registered, newest first */
			listInstallations: () => Promise<ResidentInstallation[]>
			/** Links an installation to an org / billing customer (`null` clears a field) */
			upsertInstallation: (
				id: string,
				update: ResidentInstallationMutation['UpsertInstallation']
			) => Promise<ResidentInstallation>
		}
	}
}

const plugin: FastifyPluginAsync = async app => {
	const { secrets, db } = app

	app.decorate('residentService', {
		authenticate: async token => {
			const installationId = installationOf(secrets.residentInstallations, token)
			if (!installationId) throw new ResidentUnauthorized()
			return installationId
		},
		recordUsage: async record => {
			await db.resident.upsertUsage(record)
			app.log.info(
				{
					installationId: record.installationId,
					day: record.day,
					totalTokens: record.totalTokens,
					billableUsd: record.cost.billableUsd,
				},
				'resident usage recorded'
			)
			return { id: usageRecordId(record), stored: true }
		},
		listUsage: async installationId => db.resident.listUsage({ installationId }),
		summarizeUsage: async (query = {}) => {
			const [summaries, reports] = await Promise.all([
				db.resident.summarizeUsage(query),
				db.resident.listUsageReports(query.month),
			])
			const reportOf = new Map(
				reports.map(report => [`${report.installationId}/${report.month}`, report])
			)
			return summaries.map(summary => ({
				...summary,
				report: reportOf.get(`${summary.installationId}/${summary.month}`),
			}))
		},
		listInstallations: async () => db.resident.listInstallations(),
		upsertInstallation: async (id, update) => db.resident.upsertInstallation({ id, ...update }),
	})
}

export default fp(plugin, {
	name: '#internal/residentService',
	dependencies: ['#internal/secrets', '#internal/db'],
})
