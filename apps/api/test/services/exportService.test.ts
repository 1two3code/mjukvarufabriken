import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob, createMockJobEvent } from '#/plugins/__mocks__/db.ts'
import { createMockListedObjects } from '#/plugins/__mocks__/s3.ts'
import { createMockDeliverable } from '#/services/__mocks__/jobService.ts'
import { createMockDatabaseDump } from '#/services/__mocks__/previewDbService.ts'
import {
	deletionCertificate,
	exportFreshnessMs,
	exportJson,
	exportKeyFor,
	isExportFresh,
	pickExportJob,
	storageExportName,
} from '#/services/exportService.ts'

import type { FastifyInstance } from 'fastify'
import type { Job, Order, OrderExport } from '@mf/models'

const user = { userId: 'user-1', role: 'user', orgId: 'org-1' } as const
const admin = { userId: 'admin-1', role: 'admin', orgId: 'org-admin' } as const

describe('Export Service', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		// Real exportService over the in-memory orders/order_exports; jobs, s3 and the preview
		// services stay mocked (no AWS, no Postgres in the loop).
		app = await createTestApp({ skipMock: '#/services/exportService.ts' })
	})

	afterEach(() => vi.useRealTimers())

	const seedOrder = async (id = 'order-1', orgId = 'org-1') =>
		app.db.orders.insert({ id, orgId, name: 'Acme gym' })

	/** A delivered build whose last bundle event carries the deliverable */
	const seedDeliveredJob = (overrides: Partial<Job> = {}) => {
		const job = createMockJob({
			id: 'job-1',
			orderId: 'order-1',
			status: 'delivered',
			finishedAt: '2026-08-26T13:00:00.000Z',
			...overrides,
		})
		vi.spyOn(app.db.jobs, 'list').mockResolvedValue([job])
		vi.spyOn(app.db.jobs, 'listEvents').mockResolvedValue([
			createMockJobEvent({
				id: 5,
				jobId: job.id,
				type: 'delivery',
				payload: {
					step: 'bundle',
					ok: true,
					deliverable: createMockDeliverable({ jobId: job.id }),
				},
			}),
		])
		return job
	}

	// MARK: finalExport

	describe('finalExport', () => {
		it('Copies the repo zip, dumps the database and copies the storage prefix under the export key', async () => {
			await seedOrder()
			seedDeliveredJob()
			vi.mocked(app.s3.listObjects).mockResolvedValue(createMockListedObjects('preview/job1/', 2))

			const result = await app.exportService.finalExport('order-1')

			expect(result.status).toBe('done')
			expect(result.jobId).toBe('job-1')
			expect(result.key).toBe('deliverables/job-1/export/')
			expect(result.files.map(file => file.name)).toEqual([
				'repo.zip',
				'database.json',
				'storage/photo-1.jpg',
				'storage/photo-2.jpg',
				'storage-manifest.json',
			])
			// The repo comes from the delivered bundle in the artifacts bucket…
			expect(app.s3.copyToArtifacts).toHaveBeenCalledWith(
				{ bucket: 'mf-artifacts-test', key: 'deliverables/job-1/repo.zip' },
				'deliverables/job-1/export/repo.zip'
			)
			// …the objects from the app's own prefix in the preview bucket
			expect(app.s3.listObjects).toHaveBeenCalledWith('mf-preview-test', 'preview/job1/')
			expect(app.s3.copyToArtifacts).toHaveBeenCalledWith(
				{ bucket: 'mf-preview-test', key: 'preview/job1/photo-2.jpg' },
				'deliverables/job-1/export/storage/photo-2.jpg'
			)
			// The dump is the provisioning job's database, serialised as JSON
			expect(app.previewDbService.dump).toHaveBeenCalledWith('job-1')
			const [databaseKey, databaseBody, contentType] = vi.mocked(app.s3.putArtifact).mock.calls[0]!
			expect(databaseKey).toBe('deliverables/job-1/export/database.json')
			expect(contentType).toBe('application/json')
			expect(JSON.parse(databaseBody).tables[0].table).toBe('bookings')
			expect(await app.db.orderExports.get('order-1')).toMatchObject({ status: 'done' })
		})

		it('Is idempotent — a fresh done export is returned, nothing is copied again', async () => {
			await seedOrder()
			seedDeliveredJob()
			const first = await app.exportService.finalExport('order-1')
			vi.mocked(app.s3.copyToArtifacts).mockClear()
			vi.mocked(app.s3.putArtifact).mockClear()

			const second = await app.exportService.finalExport('order-1')

			expect(second).toEqual(first)
			expect(app.s3.copyToArtifacts).not.toHaveBeenCalled()
			expect(app.s3.putArtifact).not.toHaveBeenCalled()
		})

		it('Retakes a done export older than the freshness window, so a teardown never certifies stale data', async () => {
			await seedOrder()
			seedDeliveredJob()
			const first = await app.exportService.finalExport('order-1')
			expect(isExportFresh(first)).toBe(true)
			vi.mocked(app.s3.copyToArtifacts).mockClear()
			vi.useFakeTimers()
			vi.setSystemTime(Date.now() + exportFreshnessMs + 60_000)
			expect(isExportFresh(first)).toBe(false)

			const retaken = await app.exportService.finalExport('order-1')

			expect(retaken.status).toBe('done')
			expect(isExportFresh(retaken)).toBe(true)
			expect(retaken.finishedAt).not.toBe(first.finishedAt)
			expect(app.s3.copyToArtifacts).toHaveBeenCalled()
		})

		it('Never retakes the export of a torn-down order — there is nothing left, and it holds the certificate', async () => {
			await seedOrder()
			seedDeliveredJob()
			const first = await app.exportService.finalExport('order-1')
			await app.db.orders.setLifecycle('order-1', ['active'], 'torn_down')
			vi.mocked(app.s3.copyToArtifacts).mockClear()
			vi.useFakeTimers()
			vi.setSystemTime(Date.now() + exportFreshnessMs + 60_000)

			const again = await app.exportService.finalExport('order-1')

			expect(again).toEqual(first)
			expect(app.s3.copyToArtifacts).not.toHaveBeenCalled()
		})

		it('Serialises BigInt columns (int8 / bigserial) instead of failing the whole export', async () => {
			await seedOrder()
			seedDeliveredJob()
			vi.mocked(app.previewDbService.dump).mockResolvedValue(
				createMockDatabaseDump({
					tables: [
						{
							table: 'bookings',
							columns: ['id', 'member'],
							rows: [{ id: 9007199254740993n, member: 'anna' }],
							truncated: false,
						},
					],
				})
			)

			const result = await app.exportService.finalExport('order-1')

			expect(result.status).toBe('done')
			const [, databaseBody] = vi.mocked(app.s3.putArtifact).mock.calls[0]!
			expect(JSON.parse(databaseBody).tables[0].rows[0]).toEqual({
				id: '9007199254740993',
				member: 'anna',
			})
		})

		it('Skips the database and the storage cleanly when the order never had them', async () => {
			await seedOrder()
			seedDeliveredJob()
			vi.mocked(app.previewDbService.dump).mockResolvedValue(undefined)
			app.secrets.infra.previewBucket = undefined

			const result = await app.exportService.finalExport('order-1')

			expect(result.status).toBe('done')
			expect(result.files.map(file => file.name)).toEqual(['repo.zip'])
			expect(app.s3.listObjects).not.toHaveBeenCalled()
		})

		it('Records a failed step with its reason and retries it on the next call', async () => {
			await seedOrder()
			seedDeliveredJob()
			vi.mocked(app.s3.copyToArtifacts).mockRejectedValueOnce(new Error('S3 down'))

			const failed = await app.exportService.finalExport('order-1')
			expect(failed.status).toBe('failed')
			expect(failed.error).toBe('S3 down')
			expect(failed.files).toEqual([])

			const retried = await app.exportService.finalExport('order-1')
			expect(retried.status).toBe('done')
			expect(retried.files.map(file => file.name)).toContain('repo.zip')
		})

		it('Exports a redelivery from its SOURCE job’s resources, under the redelivery’s own key', async () => {
			await seedOrder()
			seedDeliveredJob({ id: 'job-2', mode: 'redeliver', sourceJobId: 'job-1' })

			const result = await app.exportService.finalExport('order-1')

			expect(result.key).toBe('deliverables/job-2/export/')
			expect(app.previewDbService.dump).toHaveBeenCalledWith('job-1')
			expect(app.s3.listObjects).toHaveBeenCalledWith('mf-preview-test', 'preview/job1/')
		})

		it('Finishes an order that never delivered as done with nothing to export', async () => {
			await seedOrder()
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([])

			const result = await app.exportService.finalExport('order-1')

			expect(result).toMatchObject({
				status: 'done',
				files: [],
				key: 'deliverables/order-1/export/',
			})
			expect(result.jobId).toBeUndefined()
			expect(app.s3.copyToArtifacts).not.toHaveBeenCalled()
		})

		it('Throws EntityNotFound for an unknown order', async () => {
			await expect(app.exportService.finalExport('order-nope')).rejects.toThrow(EntityNotFound)
		})
	})

	// MARK: getForOrder

	describe('getForOrder', () => {
		it('Presigns every file, org-scoped; admins see every org', async () => {
			await seedOrder()
			seedDeliveredJob()
			await app.exportService.finalExport('order-1')

			const result = await app.exportService.getForOrder('order-1', user)

			expect(result.files.every(file => file.url.includes('X-Amz-Signature'))).toBe(true)
			expect(result.files[0]!.expiresAt).toMatch(/Z$/)
			await expect(app.exportService.getForOrder('order-1', admin)).resolves.toMatchObject({
				status: 'done',
			})
			await expect(
				app.exportService.getForOrder('order-1', { ...user, orgId: 'org-other' })
			).rejects.toThrow(EntityNotFound)
		})

		it('Is not found until an export exists', async () => {
			await seedOrder()

			await expect(app.exportService.getForOrder('order-1', user)).rejects.toThrow(EntityNotFound)
		})
	})

	// MARK: writeDeletionCertificate

	describe('writeDeletionCertificate', () => {
		const report = {
			label: 'hosting window ended',
			completedAt: new Date('2026-09-30T00:00:00.000Z'),
			previewResources: [
				{
					jobId: 'job-1',
					database: 'deleted' as const,
					databaseRole: 'deleted' as const,
					storageObjects: 'already-gone' as const,
					storageObjectCount: 0,
					storageRole: 'deleted' as const,
				},
			],
			repositoryUrl: 'https://github.com/mjukvaruhuset/gym-booking-job1',
		}

		it('Appends DELETION-CERTIFICATE.md to the done export', async () => {
			await seedOrder()
			seedDeliveredJob()
			await app.exportService.finalExport('order-1')

			const result = await app.exportService.writeDeletionCertificate('order-1', report)

			const certificate = result.files.at(-1)
			expect(certificate).toMatchObject({
				name: 'DELETION-CERTIFICATE.md',
				key: 'deliverables/job-1/export/DELETION-CERTIFICATE.md',
			})
			const [, body, contentType] = vi.mocked(app.s3.putArtifact).mock.calls.at(-1)!
			expect(contentType).toBe('text/markdown')
			expect(body).toContain('Teardown completed 2026-09-30T00:00:00.000Z (hosting window ended)')
			expect(body).toContain('https://github.com/mjukvaruhuset/gym-booking-job1')
			expect(body).toContain('Database of build `job-1`: deleted')
			expect((await app.db.orderExports.get('order-1'))?.files).toHaveLength(result.files.length)
		})

		it('Creates a done export holding only the certificate when the teardown skipped the export', async () => {
			await seedOrder()

			const result = await app.exportService.writeDeletionCertificate('order-1', report)

			expect(result.status).toBe('done')
			expect(result.files.map(file => file.name)).toEqual(['DELETION-CERTIFICATE.md'])
		})
	})

	// MARK: Pure helpers

	describe('helpers', () => {
		it('Writes BigInt as a decimal string and leaves everything else to JSON', () => {
			expect(exportJson({ id: 42n, when: new Date('2026-09-02T00:00:00.000Z'), n: 1 })).toBe(
				'{\n  "id": "42",\n  "when": "2026-09-02T00:00:00.000Z",\n  "n": 1\n}'
			)
		})

		it('Keeps the object path relative to the app prefix under storage/', () => {
			expect(storageExportName('preview/job1/albums/a.jpg', 'preview/job1/')).toBe(
				'storage/albums/a.jpg'
			)
			expect(exportKeyFor('job-1')).toBe('deliverables/job-1/export/')
		})

		it('Picks the newest delivered job with a bundle, else the newest finished job', async () => {
			const older = createMockJob({
				id: 'a',
				status: 'delivered',
				createdAt: '2026-01-01T00:00:00.000Z',
			})
			const newer = createMockJob({
				id: 'b',
				status: 'delivered',
				createdAt: '2026-02-01T00:00:00.000Z',
			})
			const failed = createMockJob({
				id: 'c',
				status: 'failed',
				createdAt: '2026-03-01T00:00:00.000Z',
				finishedAt: '2026-03-01T01:00:00.000Z',
			})
			const bundle = (jobId: string) =>
				createMockJobEvent({
					jobId,
					type: 'delivery',
					payload: { step: 'bundle', ok: true, deliverable: createMockDeliverable({ jobId }) },
				})

			const picked = await pickExportJob([older, failed, newer], async jobId =>
				jobId === 'a' ? [bundle('a')] : []
			)
			expect(picked?.job.id).toBe('a')
			expect(picked?.deliverable?.jobId).toBe('a')

			const fallback = await pickExportJob([older, failed, newer], async () => [])
			expect(fallback?.job.id).toBe('c')
			expect(fallback?.deliverable).toBeUndefined()
		})

		it('Writes a certificate a customer can read: what went, what stayed', () => {
			const order = { id: 'order-1', orgId: 'org-1', name: 'Acme gym' } as Order
			const exported: OrderExport = {
				orderId: 'order-1',
				key: 'deliverables/job-1/export/',
				status: 'done',
				files: [{ name: 'repo.zip', key: 'deliverables/job-1/export/repo.zip', size: 10 }],
				createdAt: '2026-09-30T00:00:00.000Z',
			}
			const text = deletionCertificate(order, exported, {
				label: 'hosting window ended',
				completedAt: new Date('2026-09-30T00:00:00.000Z'),
				previewResources: [],
			})
			expect(text).toContain('# Deletion certificate — Acme gym')
			expect(text).toContain('Hosted app: no service was recorded')
			expect(text).toContain('was not touched')
			expect(text).toContain('`repo.zip` (10 bytes)')
		})
	})
})
