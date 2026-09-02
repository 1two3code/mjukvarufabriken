/**
 * The final export before an order's hosting window ends (wave 14, strategy F4 — single-use
 * hosting). The customer bought a repo and a window of hosting, not a service; when the window
 * closes, everything the delivery provisioned is torn down — but first, everything the customer
 * put INTO it is copied where they can still download it: the repo zip, a full dump of the
 * app's database and a copy of its object storage, all under `deliverables/<jobId>/export/` in
 * the artifacts bucket. At teardown completion a DELETION-CERTIFICATE.md joins them, stating
 * what was deleted and when.
 *
 * Idempotent through the `order_exports` row: `finalExport` claims it with a compare-and-set
 * (`db.orderExports.claim`) and does the work only when it won the claim. A `done` export is
 * final; a `failed` one (or a claim that went stale — a crashed run) is retried by the next
 * caller, which is the hourly hosting sweep.
 */
import fp from 'fastify-plugin'
import { orderExportFileName } from '@mf/models'

import { EntityNotFound } from '#/lib/entityError.ts'
import { defaultDownloadExpirySeconds } from '#/plugins/s3.ts'
import { deliverableFromEvents, provisioningJobIdOf } from '#/services/jobService.utils.ts'
import { previewPrefix } from '#/services/previewStorageService.ts'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type {
	BackendSession,
	Deliverable,
	Job,
	Order,
	OrderExport,
	OrderExportFile,
	OrderExportResponse,
	PreviewTeardownReport,
} from '@mf/models'
import type { DeprovisionResult } from '@mf/org'

/** What the deletion certificate records about the teardown that just completed */
export type DeletionReport = {
	/** Who / what tore the order down (`hosting window ended`, an admin's label, …) */
	label: string
	completedAt: Date
	/** The @mf/org deprovision result (Express service etc.); absent when nothing was recorded */
	deprovision?: DeprovisionResult
	/** Per provisioning job: database, role, storage prefix, storage role */
	previewResources: PreviewTeardownReport[]
	/** The customer's repository — theirs, never deleted; named so the certificate can say so */
	repositoryUrl?: string
}

declare module 'fastify' {
	interface FastifyInstance {
		exportService: {
			/**
			 * Takes (or returns the already-taken) final export of the order. Resolves to the export
			 * row in every case — inspect `status`: `done` means every file is in place, `failed`
			 * means a step threw (the row keeps the reason and the next call retries), `pending`
			 * means another run is in flight right now. Throws `EntityNotFound` for an unknown order.
			 */
			finalExport: (orderId: string) => Promise<OrderExport>
			/** The order's export with presigned links; org-scoped (`EntityNotFound` for other orgs / none) */
			getForOrder: (orderId: string, session: BackendSession) => Promise<OrderExportResponse>
			/**
			 * Writes DELETION-CERTIFICATE.md under the order's export prefix once the teardown
			 * completed and appends it to the export's files (creating a `done` export holding only
			 * the certificate when the teardown skipped the export). Best-effort by contract of the
			 * caller: the certificate must never undo a completed teardown.
			 */
			writeDeletionCertificate: (orderId: string, report: DeletionReport) => Promise<OrderExport>
		}
	}
}

// MARK: Pure helpers (exported for tests)

/** A `pending` claim older than this is a crashed run and may be re-claimed */
export const exportClaimStaleMs = 60 * 60 * 1000

/** Where an order's export lives: next to the delivered bundle, under its own sub-prefix */
export const exportKeyFor = (jobId: string) => `deliverables/${jobId}/export/`

/** Storage objects keep their path relative to the app's prefix: `preview/<t>/a/b.jpg` → `storage/a/b.jpg` */
export const storageExportName = (objectKey: string, prefix: string) =>
	`${orderExportFileName.storagePrefix}${objectKey.slice(prefix.length)}`

const outcomeLine = (outcome: string) => (outcome === 'skipped' ? 'skipped' : outcome)

/**
 * The certificate text: plain Markdown a customer (or their auditor) can read without us. It
 * lists what was deleted, per resource, and what deliberately was not (their repository).
 */
export const deletionCertificate = (
	order: Order,
	exported: OrderExport,
	report: DeletionReport
): string => {
	const lines = [
		`# Deletion certificate — ${order.name}`,
		'',
		`Order \`${order.id}\` (organisation \`${order.orgId}\`).`,
		`Teardown completed ${report.completedAt.toISOString()} (${report.label}).`,
		'',
		'## What was deleted',
		'',
	]
	if (report.deprovision) {
		const { summary } = report.deprovision
		lines.push(
			`- Hosted app (ECS Express service and its load balancer): ${summary.deleted} deleted, ${summary['already-gone']} already gone.`
		)
	} else {
		lines.push('- Hosted app: no service was recorded for this order.')
	}
	for (const resources of report.previewResources) {
		lines.push(
			`- Database of build \`${resources.jobId}\`: ${outcomeLine(resources.database)}; its login role: ${outcomeLine(resources.databaseRole)}.`,
			`- Object storage of build \`${resources.jobId}\`: ${outcomeLine(resources.storageObjects)} (${resources.storageObjectCount} objects); its IAM role: ${outcomeLine(resources.storageRole)}.`
		)
		if (resources.reason) lines.push(`  - Note: ${resources.reason}`)
	}
	lines.push(
		'',
		'## What was kept',
		'',
		report.repositoryUrl
			? `- Your repository at ${report.repositoryUrl} is yours and was not touched.`
			: '- Your repository (transferred to you at delivery) was not touched.',
		`- This export (\`${exported.key}\`), downloadable from your order page:`,
		...exported.files.map(file => `  - \`${file.name}\` (${file.size} bytes)`),
		'',
		'Every deletion above is permanent; the platform holds no further copy of the data.',
		''
	)
	return lines.join('\n')
}

/** The order's delivered job with a bundle (newest first), else its newest finished job */
export const pickExportJob = async (
	jobs: Job[],
	eventsOf: (jobId: string) => Promise<Parameters<typeof deliverableFromEvents>[0]>
): Promise<{ job: Job; deliverable?: Deliverable } | undefined> => {
	const newestFirst = jobs.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
	for (const job of newestFirst) {
		if (job.status !== 'delivered') continue
		const deliverable = deliverableFromEvents(await eventsOf(job.id))
		if (deliverable) return { job, deliverable }
	}
	const finished = newestFirst.find(job => job.finishedAt !== undefined)
	return finished && { job: finished }
}

// MARK: Plugin

const plugin: FastifyPluginAsync = async app => {
	const { db, s3, secrets, previewDbService } = app

	const isAdmin = (session: BackendSession) => session.role === 'admin'

	/** Every file the export writes under `key`, in order: repo, database, storage */
	const collectExport = async (
		key: string,
		job: Job,
		deliverable: Deliverable | undefined
	): Promise<OrderExportFile[]> => {
		const files: OrderExportFile[] = []
		const artifactsBucket = secrets.infra.artifactsBucket
		const repo = deliverable?.files.find(file => file.name === orderExportFileName.repo)
		if (repo && artifactsBucket) {
			const target = `${key}${orderExportFileName.repo}`
			const { size } = await s3.copyToArtifacts({ bucket: artifactsBucket, key: repo.key }, target)
			files.push({ name: orderExportFileName.repo, key: target, size })
		}

		const provisioningJobId = provisioningJobIdOf(job)
		const dump = await previewDbService.dump(provisioningJobId)
		if (dump) {
			const target = `${key}${orderExportFileName.database}`
			const { size } = await s3.putArtifact(
				target,
				JSON.stringify(dump, null, 2),
				'application/json'
			)
			files.push({ name: orderExportFileName.database, key: target, size })
		}

		const previewBucket = secrets.infra.previewBucket
		if (previewBucket) {
			const prefix = previewPrefix(provisioningJobId)
			const objects = await s3.listObjects(previewBucket, prefix)
			for (const object of objects) {
				const name = storageExportName(object.key, prefix)
				const target = `${key}${name}`
				const { size } = await s3.copyToArtifacts(
					{ bucket: previewBucket, key: object.key },
					target
				)
				files.push({ name, key: target, size })
			}
			if (objects.length) {
				const manifest = {
					bucket: previewBucket,
					prefix,
					objects,
					exportedAt: new Date().toISOString(),
				}
				const target = `${key}${orderExportFileName.storageManifest}`
				const { size } = await s3.putArtifact(
					target,
					JSON.stringify(manifest, null, 2),
					'application/json'
				)
				files.push({ name: orderExportFileName.storageManifest, key: target, size })
			}
		}
		return files
	}

	const finalExport: FastifyInstance['exportService']['finalExport'] = async orderId => {
		const order = await db.orders.getOrder(orderId)
		if (!order) throw new EntityNotFound('order', orderId)

		const picked = await pickExportJob(await db.jobs.list({ orderId }), jobId =>
			db.jobs.listEvents(jobId)
		)
		const key = exportKeyFor(picked?.job.id ?? orderId)
		const { export: claimed, claimed: won } = await db.orderExports.claim(
			{ orderId, jobId: picked?.job.id, key },
			new Date(Date.now() - exportClaimStaleMs)
		)
		if (!won) {
			app.log.info({ orderId, status: claimed.status }, 'Final export already taken / in flight')
			return claimed
		}

		try {
			const files = picked ? await collectExport(key, picked.job, picked.deliverable) : []
			const done = await db.orderExports.finish(orderId, { status: 'done', files })
			app.log.info({ orderId, key, files: files.length }, 'Final export done')
			return done ?? claimed
		} catch (error) {
			const message = (error as Error).message
			app.log.error({ err: error, orderId, key }, 'Final export failed')
			const failed = await db.orderExports.finish(orderId, {
				status: 'failed',
				files: [],
				error: message,
			})
			return failed ?? { ...claimed, status: 'failed', error: message }
		}
	}

	const getForOrder: FastifyInstance['exportService']['getForOrder'] = async (orderId, session) => {
		const order = await db.orders.getOrder(orderId)
		if (!order || (!isAdmin(session) && order.orgId !== session.orgId)) {
			throw new EntityNotFound('order', orderId)
		}
		const exported = await db.orderExports.get(orderId)
		if (!exported) throw new EntityNotFound('export', orderId)
		const expiresAt = new Date(Date.now() + defaultDownloadExpirySeconds * 1000).toISOString()
		const files = await Promise.all(
			exported.files.map(async file => ({
				...file,
				url: await s3.presignDownload(file.key, defaultDownloadExpirySeconds),
				expiresAt,
			}))
		)
		return { ...exported, files }
	}

	const writeDeletionCertificate: FastifyInstance['exportService']['writeDeletionCertificate'] =
		async (orderId, report) => {
			const order = await db.orders.getOrder(orderId)
			if (!order) throw new EntityNotFound('order', orderId)
			// A teardown that skipped the export still gets its certificate: claim a row for it
			let exported = await db.orderExports.get(orderId)
			if (!exported) {
				const { export: claimed } = await db.orderExports.claim(
					{ orderId, key: exportKeyFor(orderId) },
					new Date(Date.now() - exportClaimStaleMs)
				)
				exported = (await db.orderExports.finish(orderId, { status: 'done', files: [] })) ?? claimed
			}
			const target = `${exported.key}${orderExportFileName.deletionCertificate}`
			const { size } = await s3.putArtifact(
				target,
				deletionCertificate(order, exported, report),
				'text/markdown'
			)
			const file: OrderExportFile = {
				name: orderExportFileName.deletionCertificate,
				key: target,
				size,
			}
			const updated = await db.orderExports.appendFiles(orderId, [file])
			app.log.info({ orderId, key: target }, 'Deletion certificate written')
			return updated ?? { ...exported, files: [...exported.files, file] }
		}

	app.decorate('exportService', { finalExport, getForOrder, writeDeletionCertificate })
}

export default fp(plugin, {
	name: '#internal/exportService',
	dependencies: ['#internal/db', '#internal/s3', '#internal/secrets', '#internal/previewDbService'],
})
