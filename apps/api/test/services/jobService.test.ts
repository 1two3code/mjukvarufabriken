import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob, createMockJobEvent } from '#/plugins/__mocks__/db.ts'
import { mockTaskArn } from '#/plugins/__mocks__/ecs.ts'
import { createMockSpec, createMockSpecDraft } from '#/services/__mocks__/specService.ts'
import { budgetForSize, JobAlreadyActive, SpecNotFrozen } from '#/services/jobService.ts'

import type { FastifyInstance } from 'fastify'
import type { BackendSession } from '@mf/models'

const user: BackendSession = { userId: 'user-1', role: 'user', orgId: 'org-1' }
const admin: BackendSession = { userId: 'admin-1', role: 'admin', orgId: 'org-admin' }

describe('Job Service', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/services/jobService.ts' })
	})

	describe('start', () => {
		const frozen = () =>
			createMockSpecDraft({
				orderId: 'order-1',
				status: 'frozen',
				spec: { ...createMockSpec(), sizeClass: 'M' },
				frozenAt: '2026-08-26T12:00:00.000Z',
			})

		it('Rejects an unfrozen spec', async () => {
			await expect(app.jobService.start('order-1', user)).rejects.toBeInstanceOf(SpecNotFrozen)
			expect(app.db.jobs.insert).not.toHaveBeenCalled()
		})

		it("Cannot start a build on another org's order (404, no row, no task)", async () => {
			vi.spyOn(app.specService, 'get').mockRejectedValue(new EntityNotFound('spec', 'order-1'))

			await expect(
				app.jobService.start('order-1', { ...user, orgId: 'org-2' })
			).rejects.toBeInstanceOf(EntityNotFound)
			expect(app.specService.get).toHaveBeenCalledWith('order-1', { ...user, orgId: 'org-2' })
			expect(app.db.jobs.insert).not.toHaveBeenCalled()
			expect(app.ecs.runJob).not.toHaveBeenCalled()
		})

		it("Tags the job with the order's org (admin starting for a customer)", async () => {
			vi.spyOn(app.specService, 'get').mockResolvedValue({ ...frozen(), orgId: 'org-7' })
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([])

			await app.jobService.start('order-1', admin)

			expect(app.db.jobs.insert).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-7' }))
		})

		it('Maps the one-active-job unique violation to JobAlreadyActive (double-start race)', async () => {
			vi.spyOn(app.specService, 'get').mockResolvedValue(frozen())
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([])
			vi.spyOn(app.db.jobs, 'insert').mockRejectedValue(
				Object.assign(new Error('duplicate key value violates unique constraint'), {
					code: '23505',
				})
			)

			await expect(app.jobService.start('order-1', user)).rejects.toBeInstanceOf(JobAlreadyActive)
			expect(app.ecs.runJob).not.toHaveBeenCalled()
		})

		it('Rejects a second active job for the order', async () => {
			vi.spyOn(app.specService, 'get').mockResolvedValue(frozen())
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([createMockJob({ status: 'building' })])

			await expect(app.jobService.start('order-1', user)).rejects.toBeInstanceOf(JobAlreadyActive)
		})

		it('Inserts the job with the budget of its size class, runs the task and stores the ARN', async () => {
			vi.spyOn(app.specService, 'get').mockResolvedValue(frozen())
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([createMockJob({ status: 'failed' })])

			const job = await app.jobService.start('order-1', user)

			expect(app.db.jobs.insert).toHaveBeenCalledWith({
				orderId: 'order-1',
				orgId: 'org-1',
				spec: { ...createMockSpec(), sizeClass: 'M' },
				budget: budgetForSize.M,
			})
			expect(app.ecs.runJob).toHaveBeenCalledWith('job-1')
			expect(app.db.jobs.update).toHaveBeenCalledWith('job-1', { taskArn: mockTaskArn })
			expect(job.taskArn).toBe(mockTaskArn)
		})

		it('Only inserts the row when ECS is not configured', async () => {
			vi.spyOn(app.specService, 'get').mockResolvedValue(frozen())
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([])
			app.ecs.configured = false

			const job = await app.jobService.start('order-1', user)

			expect(app.ecs.runJob).not.toHaveBeenCalled()
			expect(job.status).toBe('queued')
			expect(job.taskArn).toBeUndefined()
		})

		it('Marks the job failed when RunTask throws', async () => {
			vi.spyOn(app.specService, 'get').mockResolvedValue(frozen())
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([])
			vi.spyOn(app.ecs, 'runJob').mockRejectedValue(new Error('no capacity'))

			const job = await app.jobService.start('order-1', user)

			expect(job.status).toBe('failed')
			expect(app.db.jobs.appendEvent).toHaveBeenCalledWith(
				'job-1',
				expect.objectContaining({ type: 'failed' })
			)
		})
	})

	describe('get / listEvents (org scoping)', () => {
		it('Returns the job for its own org and for admins', async () => {
			await expect(app.jobService.get('job-1', user)).resolves.toMatchObject({ id: 'job-1' })
			await expect(app.jobService.get('job-1', admin)).resolves.toMatchObject({ id: 'job-1' })
		})

		it('Hides jobs of other orgs as not found', async () => {
			const other = { ...user, orgId: 'org-2' }
			await expect(app.jobService.get('job-1', other)).rejects.toBeInstanceOf(EntityNotFound)
			await expect(app.jobService.listEvents('job-1', 0, other)).rejects.toBeInstanceOf(
				EntityNotFound
			)
		})

		it('Passes the cursor through to the repository', async () => {
			await app.jobService.listEvents('job-1', 42, user)
			expect(app.db.jobs.listEvents).toHaveBeenCalledWith('job-1', 42)
		})

		it('Hides notify events and gate details from customers, not from admins', async () => {
			const gate = {
				...createMockJobEvent({ id: 2, type: 'gate' }),
				payload: {
					name: 'review',
					ok: true,
					summary: '1 finding(s), none high/medium open',
					details: { findings: [{ file: 'apps/api/src/routes/login.ts', line: 40 }] },
				},
			}
			const notify = {
				...createMockJobEvent({ id: 3, type: 'notify' }),
				payload: { to: 'admins', subject: 'Build job job-1 failed', text: 'secret-ish' },
			}
			vi.spyOn(app.db.jobs, 'listEvents').mockResolvedValue([createMockJobEvent(), gate, notify])

			const forCustomer = await app.jobService.listEvents('job-1', 0, user)
			const forAdmin = await app.jobService.listEvents('job-1', 0, admin)

			expect(forCustomer.map(event => event.type)).toEqual(['started', 'gate'])
			expect(forCustomer[1]!.payload).toEqual({
				name: 'review',
				ok: true,
				summary: '1 finding(s), none high/medium open',
			})
			expect(forAdmin).toEqual([createMockJobEvent(), gate, notify])
		})

		it('Filters the order list by org for users', async () => {
			vi.spyOn(app.db.jobs, 'list').mockResolvedValue([
				createMockJob({ id: 'a', orgId: 'org-1' }),
				createMockJob({ id: 'b', orgId: 'org-2' }),
			])
			expect((await app.jobService.listForOrder('order-1', user)).map(j => j.id)).toEqual(['a'])
			expect((await app.jobService.listForOrder('order-1', admin)).map(j => j.id)).toEqual([
				'a',
				'b',
			])
		})
	})

	describe('kill', () => {
		it('Marks an active job killed, appends the event and stops the task', async () => {
			vi.spyOn(app.db.jobs, 'get').mockResolvedValue(
				createMockJob({ status: 'building', taskArn: mockTaskArn })
			)

			const job = await app.jobService.kill('job-1')

			expect(job.status).toBe('killed')
			expect(app.db.jobs.update).toHaveBeenCalledWith(
				'job-1',
				expect.objectContaining({ status: 'killed', reason: 'killed by admin' })
			)
			expect(app.db.jobs.appendEvent).toHaveBeenCalledWith('job-1', {
				type: 'killed',
				payload: { reason: 'killed by admin' },
			})
			expect(app.ecs.stopTask).toHaveBeenCalledWith(mockTaskArn, 'killed by admin')
		})

		it('Does not call StopTask without a task ARN and survives a StopTask failure', async () => {
			vi.spyOn(app.db.jobs, 'get').mockResolvedValue(createMockJob({ status: 'planning' }))
			await app.jobService.kill('job-1')
			expect(app.ecs.stopTask).not.toHaveBeenCalled()

			vi.spyOn(app.db.jobs, 'get').mockResolvedValue(
				createMockJob({ status: 'planning', taskArn: mockTaskArn })
			)
			vi.spyOn(app.ecs, 'stopTask').mockRejectedValue(new Error('gone'))
			await expect(app.jobService.kill('job-1')).resolves.toMatchObject({ status: 'killed' })
		})

		it('Leaves finished jobs untouched and 404s unknown ids', async () => {
			vi.spyOn(app.db.jobs, 'get').mockResolvedValueOnce(createMockJob({ status: 'delivered' }))
			await expect(app.jobService.kill('job-1')).resolves.toMatchObject({ status: 'delivered' })
			expect(app.db.jobs.update).not.toHaveBeenCalled()

			vi.spyOn(app.db.jobs, 'get').mockResolvedValueOnce(undefined)
			await expect(app.jobService.kill('nope')).rejects.toBeInstanceOf(EntityNotFound)
		})
	})
})
