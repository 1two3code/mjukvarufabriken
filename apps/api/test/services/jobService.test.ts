import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockJob, createMockJobEvent } from '#/plugins/__mocks__/db.ts'
import { mockTaskArn } from '#/plugins/__mocks__/ecs.ts'
import { mockPresignedUrl } from '#/plugins/__mocks__/s3.ts'
import { createMockDeliverable } from '#/services/__mocks__/jobService.ts'
import { createMockSpec, createMockSpecDraft } from '#/services/__mocks__/specService.ts'
import {
	budgetForSize,
	deliverableFromEvents,
	hashReportToken,
	JobAlreadyActive,
	JobNotAwaitingApproval,
	MalformedGateReport,
	ReportUnauthorized,
	SpecNotFrozen,
	StatusRegression,
} from '#/services/jobService.ts'

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
				reportTokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
			})
			expect(app.ecs.runJob).toHaveBeenCalledWith('job-1', expect.stringMatching(/^[\w-]{43}$/))
			// The task gets the token, the row only its hash
			const [[, token]] = vi.mocked(app.ecs.runJob).mock.calls
			const [[inserted]] = vi.mocked(app.db.jobs.insert).mock.calls
			expect(hashReportToken(token)).toBe(inserted.reportTokenHash)
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

		it('Strips gate details from a customer job read but not an admin\'s', async () => {
			const gated = createMockJob({
				id: 'job-1',
				gates: [
					{ name: 'review', ok: true, tokens: 10, durationMs: 5, startedAt: '2026-08-28T00:00:00.000Z', summary: 'ok', details: { findings: [{ file: 'apps/api/src/x.ts', line: 1 }] } },
				],
			})
			vi.spyOn(app.db.jobs, 'get').mockResolvedValue(gated)

			const forUser = await app.jobService.get('job-1', user)
			expect(forUser.gates?.[0]).not.toHaveProperty('details')
			expect(forUser.gates?.[0]).toMatchObject({ name: 'review', ok: true, tokens: 10 })

			const forAdmin = await app.jobService.get('job-1', admin)
			expect(forAdmin.gates?.[0]).toHaveProperty('details')
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

	describe('report (build-container endpoint)', () => {
		const job = () => createMockJob({ id: 'job-1', status: 'building' })

		it('Resolves a token to its job by hash only', async () => {
			vi.spyOn(app.db.jobs, 'getByReportToken').mockResolvedValue(job())

			await expect(app.jobService.authenticateReport('job-1', 'tok')).resolves.toMatchObject({
				id: 'job-1',
			})
			expect(app.db.jobs.getByReportToken).toHaveBeenCalledWith(hashReportToken('tok'))
		})

		it('Rejects a missing or unknown token as unauthorized', async () => {
			vi.spyOn(app.db.jobs, 'getByReportToken').mockResolvedValue(undefined)

			await expect(app.jobService.authenticateReport('job-1', undefined)).rejects.toBeInstanceOf(
				ReportUnauthorized
			)
			await expect(app.jobService.authenticateReport('job-1', 'nope')).rejects.toBeInstanceOf(
				ReportUnauthorized
			)
			expect(app.db.jobs.getByReportToken).toHaveBeenCalledTimes(1)
		})

		it("Treats a valid token on another job's url as not found", async () => {
			vi.spyOn(app.db.jobs, 'getByReportToken').mockResolvedValue(createMockJob({ id: 'job-2' }))

			await expect(app.jobService.authenticateReport('job-1', 'tok')).rejects.toBeInstanceOf(
				EntityNotFound
			)
		})

		it('Rejects the token of a finished job as unauthorized', async () => {
			vi.spyOn(app.db.jobs, 'getByReportToken').mockResolvedValue(
				createMockJob({ id: 'job-1', status: 'delivered' })
			)

			await expect(app.jobService.authenticateReport('job-1', 'tok')).rejects.toBeInstanceOf(
				ReportUnauthorized
			)
		})

		it('Rotates the token: a fresh secret out, only its hash on the row', async () => {
			const token = await app.jobService.rotateReportToken(job())

			expect(token).toMatch(/^[\w-]{43}$/)
			expect(app.db.jobs.update).toHaveBeenCalledWith('job-1', {
				reportTokenHash: hashReportToken(token),
			})
		})

		it('Exposes only spec, budget, waivers and the kill flag', async () => {
			const view = await app.jobService.reportView(
				createMockJob({ status: 'killed', gateWaivers: ['a.ts:1'], taskArn: 'arn' })
			)

			expect(view).toEqual({
				id: 'job-1',
				status: 'killed',
				spec: createMockJob().spec,
				budget: createMockJob().budget,
				gateWaivers: ['a.ts:1'],
				killed: true,
				approveBeforeDeliver: false,
				approved: false,
			})
		})

		it('Reports the approve-before-deliver gate from the order and the job approval flag (W9)', async () => {
			// Arrange — the order carries the flag; the job has been approved
			await app.db.orders.insert({ id: 'order-1', orgId: 'org-1', name: 'Gym' })
			await app.db.orders.setApproveBeforeDeliver('order-1', true)

			// Act
			const held = await app.jobService.reportView(createMockJob())
			const released = await app.jobService.reportView(createMockJob({ approved: true }))

			// Assert
			expect(held).toMatchObject({ approveBeforeDeliver: true, approved: false })
			expect(released).toMatchObject({ approveBeforeDeliver: true, approved: true })
		})

		it("Resolves the customer's GitHub login from the order creator at read time, never a snapshot", async () => {
			// Arrange — the order exists before the creator signs in with GitHub
			const anna = await app.db.users.insertWithOrg(
				{ email: 'anna@acme.se', role: 'user' },
				{ name: 'acme.se' }
			)
			await app.db.orders.insert({
				id: 'order-1',
				orgId: anna.orgId,
				name: 'Gym',
				createdBy: anna.id,
			})

			// Act
			const before = await app.jobService.reportView(job())
			await app.db.users.linkGithub(anna.id, { githubId: '42', githubLogin: 'anna' })
			const after = await app.jobService.reportView(job())
			await app.db.users.linkGithub(anna.id, { githubId: '42', githubLogin: 'anna-renamed' })
			const renamed = await app.jobService.reportView(job())

			// Assert
			expect(before.customerGithubLogin).toBeUndefined()
			expect(after.customerGithubLogin).toBe('anna')
			expect(renamed.customerGithubLogin).toBe('anna-renamed')
		})

		it('Stores events in order, mails notify events to every admin and appends gate reports', async () => {
			const gate = {
				name: 'verify' as const,
				ok: false,
				startedAt: '2026-08-26T10:00:00.000Z',
				durationMs: 5,
				tokens: 1,
				summary: 'lint failed',
			}
			const previous = { ...gate, name: 'review' as const, ok: true }
			vi.spyOn(app.db.jobs, 'get').mockResolvedValue(createMockJob({ gates: [previous] }))
			vi.spyOn(app.db.jobs, 'appendEvent')
				.mockResolvedValueOnce(createMockJobEvent({ id: 7 }))
				.mockResolvedValueOnce(createMockJobEvent({ id: 8 }))
			app.secrets.authAdminEmails = ['a@example.com', 'b@example.com']

			const result = await app.jobService.reportEvents(job(), [
				{ type: 'gate', payload: gate },
				{ type: 'notify', payload: { to: 'admins', subject: 'Job failed', text: 'details' } },
			])

			expect(result).toEqual({ lastEventId: 8 })
			expect(app.db.jobs.appendEvent).toHaveBeenNthCalledWith(1, 'job-1', {
				type: 'gate',
				payload: gate,
			})
			expect(app.db.jobs.update).toHaveBeenCalledWith('job-1', { gates: [previous, gate] })
			expect(app.email.send).toHaveBeenCalledTimes(2)
			expect(app.email.send).toHaveBeenCalledWith({
				to: 'b@example.com',
				subject: '[mf test] Job failed',
				text: 'details',
			})
		})

		it('Records the deployed service per order when a bundle event reports a deployUrl', async () => {
			const deliverable = createMockDeliverable({
				deployUrl: 'https://mf-job1-gym.eu-north-1.on.aws',
				deployedService: {
					serviceName: 'mf-job1-gym',
					serviceArn: 'arn:aws:ecs:eu-north-1:0:service/default/mf-job1-gym',
					customerTag: 'gym-job1',
					image: 'ecr/mf-deliverables:mf-job1-gym',
					config: { serviceName: 'mf-job1-gym' },
				},
			})

			await app.jobService.reportEvents(job(), [
				{ type: 'delivery', payload: { step: 'bundle', ok: true, deliverable } },
			])

			const recorded = await app.db.deployedServices.listForOrder('order-1')
			expect(recorded).toHaveLength(1)
			expect(recorded[0]).toMatchObject({
				orderId: 'order-1',
				serviceName: 'mf-job1-gym',
				customerTag: 'gym-job1',
				image: 'ecr/mf-deliverables:mf-job1-gym',
			})
		})

		it('Records nothing when the deploy failed (deployUrl null) even if a service is reported', async () => {
			const deliverable = createMockDeliverable({
				deployUrl: null,
				deployedService: {
					serviceName: 'mf-job1-gym',
					customerTag: 'gym-job1',
					config: { serviceName: 'mf-job1-gym' },
				},
			})

			await app.jobService.reportEvents(job(), [
				{ type: 'delivery', payload: { step: 'bundle', ok: true, deliverable } },
			])

			expect(await app.db.deployedServices.listForOrder('order-1')).toHaveLength(0)
		})

		it('Skips a malformed notify payload and survives a mail failure', async () => {
			vi.spyOn(app.email, 'send').mockRejectedValue(new Error('ses down'))

			await expect(
				app.jobService.reportEvents(job(), [
					{ type: 'notify', payload: { nope: true } },
					{ type: 'notify', payload: { to: 'admins', subject: 's', text: 't' } },
				])
			).resolves.toEqual({ lastEventId: 1 })
			expect(app.email.send).toHaveBeenCalledTimes(1)
		})

		it('Truncates an over-long notify text instead of dropping the mail, and caps mails per job', async () => {
			const text = 'x'.repeat(30_000)
			await app.jobService.reportEvents(job(), [
				{ type: 'notify', payload: { to: 'admins', subject: 's', text } },
			])
			expect(app.email.send).toHaveBeenCalledWith(
				expect.objectContaining({ text: 'x'.repeat(20_000) })
			)

			vi.spyOn(app.db.jobs, 'countEvents').mockResolvedValue(11)
			await app.jobService.reportEvents(job(), [
				{ type: 'notify', payload: { to: 'admins', subject: 's', text: 't' } },
			])
			expect(app.db.jobs.countEvents).toHaveBeenCalledWith('job-1', 'notify')
			expect(app.email.send).toHaveBeenCalledTimes(1)
		})

		it('Stores numbered events once: a replayed batch mails and appends nothing', async () => {
			const gate = {
				name: 'review' as const,
				ok: true,
				startedAt: '2026-08-26T10:00:00.000Z',
				durationMs: 5,
				tokens: 1,
				summary: 'clean',
			}
			vi.spyOn(app.db.jobs, 'appendEventOnce').mockResolvedValue({
				event: createMockJobEvent({ id: 4 }),
				duplicate: true,
			})

			const result = await app.jobService.reportEvents(job(), [
				{ type: 'gate', payload: gate, seq: 4 },
				{ type: 'notify', payload: { to: 'admins', subject: 's', text: 't' }, seq: 5 },
			])

			expect(result).toEqual({ lastEventId: 4 })
			expect(app.db.jobs.appendEventOnce).toHaveBeenNthCalledWith(1, 'job-1', 4, {
				type: 'gate',
				payload: gate,
			})
			expect(app.db.jobs.appendEvent).not.toHaveBeenCalled()
			expect(app.db.jobs.update).not.toHaveBeenCalled()
			expect(app.email.send).not.toHaveBeenCalled()
		})

		it('Rejects a malformed gate report before storing any of the batch', async () => {
			await expect(
				app.jobService.reportEvents(job(), [
					{ type: 'log', payload: { message: 'first' } },
					{ type: 'gate', payload: { name: 'verify' } },
				])
			).rejects.toBeInstanceOf(MalformedGateReport)
			expect(app.db.jobs.appendEvent).not.toHaveBeenCalled()
			expect(app.db.jobs.update).not.toHaveBeenCalled()
		})

		it('Writes the update with Date conversion and reports the stored status', async () => {
			const result = await app.jobService.reportUpdate(job(), {
				status: 'verifying',
				tokensUsed: 10,
				finishedAt: '2026-08-26T12:00:00.000Z',
			})

			expect(app.db.jobs.update).toHaveBeenCalledWith('job-1', {
				status: 'verifying',
				tokensUsed: 10,
				startedAt: undefined,
				finishedAt: new Date('2026-08-26T12:00:00.000Z'),
			})
			expect(result).toEqual({ status: 'verifying', killed: false })
		})

		it('Publishes the tamper-proof JobTokensUsed metric from this validated write, never a log line', async () => {
			await app.jobService.reportUpdate(job(), { status: 'verifying', tokensUsed: 10 })

			expect(app.metrics.recordJobTokensUsed).toHaveBeenCalledWith('job-1', 10)
			expect(app.metrics.recordJobFailed).not.toHaveBeenCalled()
		})

		it('Publishes the tamper-proof JobsFailed metric only once the status actually lands as failed', async () => {
			await app.jobService.reportUpdate(job(), { status: 'failed', reason: 'boom' })

			expect(app.metrics.recordJobFailed).toHaveBeenCalledWith('job-1')
		})

		it('Does not publish JobsFailed when a failed write is refused (the row was already killed)', async () => {
			vi.spyOn(app.db.jobs, 'update').mockResolvedValue(undefined)

			await app.jobService.reportUpdate(job(), { status: 'failed', reason: 'boom' })

			expect(app.metrics.recordJobFailed).not.toHaveBeenCalled()
		})

		it('Prices reported usage at the model prices in effect when the order was created', async () => {
			// The order was created before the (only) seed price rows apply → no prices → fallback
			// (Sonnet list) tier; then a cheaper Sonnet row dated before the order takes over.
			const usage = {
				'claude-sonnet-5': {
					inputTokens: 1_000_000,
					outputTokens: 0,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
				},
			}
			vi.spyOn(app.db.orders, 'getOrder').mockResolvedValue({
				createdAt: '2026-09-02T00:00:00.000Z',
			} as never)

			await app.jobService.reportUpdate(job(), { tokensUsed: 5, usage })
			expect(app.db.jobs.update).toHaveBeenLastCalledWith(
				'job-1',
				expect.objectContaining({ usage, costUsd: 3 })
			)

			await app.db.modelPrices.insert({
				modelPrefix: 'claude-sonnet',
				input: 1,
				output: 5,
				cacheRead: 0.1,
				cacheWrite: 1.25,
				effectiveFrom: '2026-09-01T00:00:00.000Z',
			})
			await app.jobService.reportUpdate(job(), { tokensUsed: 5, usage })
			expect(app.db.jobs.update).toHaveBeenLastCalledWith(
				'job-1',
				expect.objectContaining({ usage, costUsd: 1 })
			)

			// A price dated after the order does not reprice it
			await app.db.modelPrices.insert({
				modelPrefix: 'claude-sonnet',
				input: 100,
				output: 500,
				cacheRead: 10,
				cacheWrite: 125,
				effectiveFrom: '2026-09-03T00:00:00.000Z',
			})
			await app.jobService.reportUpdate(job(), { tokensUsed: 5, usage })
			expect(app.db.jobs.update).toHaveBeenLastCalledWith(
				'job-1',
				expect.objectContaining({ usage, costUsd: 1 })
			)
		})

		it('Keeps usage and cost on a killed row', async () => {
			vi.spyOn(app.db.jobs, 'update').mockResolvedValue(undefined)
			const usage = {
				'claude-sonnet-5': {
					inputTokens: 1_000_000,
					outputTokens: 0,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
				},
			}

			await app.jobService.reportUpdate(job(), { status: 'failed', tokensUsed: 99, usage })

			expect(app.db.jobs.update).toHaveBeenLastCalledWith('job-1', {
				tokensUsed: 99,
				usage,
				costUsd: 3,
			})
		})

		it('Revokes the token with a terminal status', async () => {
			await app.jobService.reportUpdate(job(), { status: 'delivered', tokensUsed: 10 })

			expect(app.db.jobs.update).toHaveBeenCalledWith(
				'job-1',
				expect.objectContaining({ status: 'delivered', reportTokenHash: null })
			)
		})

		it('Refuses a status that moves the job backwards, allows repeats', async () => {
			const verifying = createMockJob({ id: 'job-1', status: 'verifying' })

			await expect(
				app.jobService.reportUpdate(verifying, { status: 'building' })
			).rejects.toBeInstanceOf(StatusRegression)
			expect(app.db.jobs.update).not.toHaveBeenCalled()
			await expect(
				app.jobService.reportUpdate(verifying, { status: 'verifying' })
			).resolves.toEqual({ status: 'verifying', killed: false })
		})

		it("Reports killed when the status write is refused: usage, plan and gates land, the admin's reason stays", async () => {
			vi.spyOn(app.db.jobs, 'update').mockResolvedValue(undefined)

			const result = await app.jobService.reportUpdate(job(), {
				status: 'failed',
				tokensUsed: 99,
				gates: [],
				reason: 'SIGTERM received',
				finishedAt: '2026-08-26T12:00:00.000Z',
			})

			expect(result).toEqual({ status: 'killed', killed: true })
			expect(app.db.jobs.update).toHaveBeenCalledTimes(2)
			expect(app.db.jobs.update).toHaveBeenLastCalledWith('job-1', { tokensUsed: 99, gates: [] })
		})

		it('Does not write again when a refused update carried only status and reason', async () => {
			vi.spyOn(app.db.jobs, 'update').mockResolvedValue(undefined)

			await app.jobService.reportUpdate(job(), { status: 'failed', reason: 'SIGTERM received' })

			expect(app.db.jobs.update).toHaveBeenCalledTimes(1)
		})
	})

	describe('kill', () => {
		it('Marks an active job killed, revokes its token, appends the event and stops the task', async () => {
			vi.spyOn(app.db.jobs, 'get').mockResolvedValue(
				createMockJob({ status: 'building', taskArn: mockTaskArn })
			)

			const job = await app.jobService.kill('job-1')

			expect(job.status).toBe('killed')
			expect(app.db.jobs.update).toHaveBeenCalledWith(
				'job-1',
				expect.objectContaining({
					status: 'killed',
					reason: 'killed by admin',
					reportTokenHash: null,
				})
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

	describe('approve (approve-before-deliver hold, W9)', () => {
		const held = () =>
			createMockJob({ status: 'verifying', awaitingApproval: true, approved: false })

		it('Flips approved on a held job so the parked container resumes into delivery', async () => {
			// Arrange
			vi.spyOn(app.db.jobs, 'get').mockResolvedValue(held())

			// Act
			const job = await app.jobService.approve('job-1', user)

			// Assert
			expect(app.db.jobs.update).toHaveBeenCalledWith('job-1', { approved: true })
			expect(job.approved).toBe(true)
		})

		it('An admin can approve another org’s held job', async () => {
			vi.spyOn(app.db.jobs, 'get').mockResolvedValue({ ...held(), orgId: 'org-9' })
			await expect(app.jobService.approve('job-1', admin)).resolves.toMatchObject({
				approved: true,
			})
		})

		it('Rejects a job that is not parked at the hold (not awaiting, already approved, finished)', async () => {
			vi.spyOn(app.db.jobs, 'get').mockResolvedValue(createMockJob({ status: 'building' }))
			await expect(app.jobService.approve('job-1', user)).rejects.toBeInstanceOf(
				JobNotAwaitingApproval
			)

			vi.spyOn(app.db.jobs, 'get').mockResolvedValue({ ...held(), approved: true })
			await expect(app.jobService.approve('job-1', user)).rejects.toBeInstanceOf(
				JobNotAwaitingApproval
			)

			vi.spyOn(app.db.jobs, 'get').mockResolvedValue({ ...held(), status: 'delivered' })
			await expect(app.jobService.approve('job-1', user)).rejects.toBeInstanceOf(
				JobNotAwaitingApproval
			)
			expect(app.db.jobs.update).not.toHaveBeenCalledWith('job-1', { approved: true })
		})

		it("404s an unknown id and another org's job (no leak, no write)", async () => {
			vi.spyOn(app.db.jobs, 'get').mockResolvedValueOnce(undefined)
			await expect(app.jobService.approve('nope', user)).rejects.toBeInstanceOf(EntityNotFound)

			vi.spyOn(app.db.jobs, 'get').mockResolvedValue({ ...held(), orgId: 'org-2' })
			await expect(app.jobService.approve('job-1', user)).rejects.toBeInstanceOf(EntityNotFound)
			expect(app.db.jobs.update).not.toHaveBeenCalledWith('job-1', { approved: true })
		})
	})

	describe('getDeliverables', () => {
		const deliverable = createMockDeliverable({ jobId: 'job-1' })
		const bundleEvent = (overrides: Record<string, unknown> = {}) => ({
			...createMockJobEvent({ id: 9, type: 'delivery' }),
			payload: { step: 'bundle', ok: true, deliverable, ...overrides },
		})

		it('Reads the record from the last successful bundle event and presigns every file', async () => {
			// Arrange
			vi.spyOn(app.db.jobs, 'listEvents').mockResolvedValue([
				createMockJobEvent({ id: 1 }),
				{ ...createMockJobEvent({ id: 2, type: 'delivery' }), payload: { step: 'repo', ok: true } },
				bundleEvent(),
			])

			// Act
			const result = await app.jobService.getDeliverables('job-1', user)

			// Assert
			expect(result).toEqual({
				...deliverable,
				files: deliverable.files.map(file => ({
					...file,
					url: mockPresignedUrl(file.key),
					expiresAt: expect.any(String),
				})),
			})
			expect(app.s3.presignDownload).toHaveBeenCalledTimes(deliverable.files.length)
			expect(app.s3.presignDownload).toHaveBeenCalledWith('deliverables/job-1/repo.zip', 900)
			const expiresAt = new Date(result.files[0]!.expiresAt).getTime() - Date.now()
			expect(expiresAt).toBeGreaterThan(14 * 60_000)
			expect(expiresAt).toBeLessThanOrEqual(15 * 60_000)
		})

		it('Is not found until a bundle step succeeded, and for other orgs', async () => {
			vi.spyOn(app.db.jobs, 'listEvents').mockResolvedValue([
				bundleEvent({ ok: false, deliverable: undefined }),
			])
			await expect(app.jobService.getDeliverables('job-1', user)).rejects.toBeInstanceOf(
				EntityNotFound
			)

			vi.spyOn(app.db.jobs, 'listEvents').mockResolvedValue([bundleEvent()])
			await expect(
				app.jobService.getDeliverables('job-1', { ...user, orgId: 'org-2' })
			).rejects.toBeInstanceOf(EntityNotFound)
			expect(app.s3.presignDownload).not.toHaveBeenCalled()
		})

		it('Picks the last successful bundle over an earlier one (re-delivery)', () => {
			const older = createMockDeliverable({ deliverableKey: 'old/' })
			const events = [
				bundleEvent({ deliverable: older }),
				{ ...bundleEvent({ deliverable: undefined, ok: false }), id: 10 },
				{ ...bundleEvent(), id: 11 },
			]
			expect(deliverableFromEvents(events)).toEqual(deliverable)
			expect(deliverableFromEvents(events.slice(0, 2))).toEqual(older)
			expect(deliverableFromEvents([])).toBeUndefined()
		})
	})
})
