import { createFakeUsageReporter } from '#/factory.ts'
import { createFakeGitHub } from '#/github.ts'
import { createFakeWorkspace, createResident } from '#/resident.ts'
import { createServer } from '#/server.ts'
import { createMemoryObjectStore } from '#/store.ts'

import type { FastifyInstance } from 'fastify'
import type { OrchestratorPorts } from '@mf/harness'

const noon = Date.parse('2026-09-03T12:00:00.000Z')

const idlePorts = (): OrchestratorPorts => {
	const never = async () => {
		throw new Error('not expected in this test')
	}
	return {
		plan: never,
		runTask: never,
		mergeTask: never,
		verify: never,
		acceptanceTests: never,
		review: never,
		acceptanceCheck: never,
	}
}

describe('resident control api', () => {
	let app: FastifyInstance
	const headers = { authorization: 'Bearer admin-token' }

	beforeEach(async () => {
		const resident = createResident({
			installationId: 'acme',
			repository: 'acme/shop',
			store: createMemoryObjectStore(),
			github: createFakeGitHub(),
			ports: idlePorts(),
			usageReporter: createFakeUsageReporter(),
			workspace: createFakeWorkspace(),
			monthlyTokens: 5000,
			task: { maxTokens: 1000, maxDurationMinutes: 10, maxWorkers: 1 },
			now: () => noon,
			log: () => {},
		})
		await resident.start()
		app = await createServer({
			resident,
			adminToken: 'admin-token',
			logLevel: 'silent',
			now: () => noon,
		})
	})

	afterEach(async () => {
		await app.close()
	})

	it('Requires the admin bearer on everything but /health', async () => {
		expect((await app.inject({ url: '/health' })).statusCode).toBe(200)
		expect((await app.inject({ url: '/status' })).statusCode).toBe(401)
		const wrong = await app.inject({ url: '/status', headers: { authorization: 'Bearer nope' } })
		expect(wrong.statusCode).toBe(401)
		expect((await app.inject({ url: '/status', headers })).statusCode).toBe(200)
	})

	it('Reports status, pauses and resumes', async () => {
		const before = await app.inject({ url: '/status', headers })
		expect(before.json()).toEqual({
			installationId: 'acme',
			repository: 'acme/shop',
			paused: false,
			month: '2026-09',
			monthlyCap: { tokens: 5000, usedTokens: 0, remainingTokens: 5000, reached: false },
			queued: 0,
		})

		const paused = await app.inject({ method: 'POST', url: '/pause', headers })
		expect(paused.json()).toEqual({ paused: true })
		expect((await app.inject({ url: '/status', headers })).json().paused).toBe(true)

		const resumed = await app.inject({ method: 'POST', url: '/resume', headers })
		expect(resumed.json()).toEqual({ paused: false })
	})

	it('Queues a task and lists it', async () => {
		const created = await app.inject({
			method: 'POST',
			url: '/tasks',
			headers,
			payload: { title: 'Add search', description: '- [ ] filters the list' },
		})
		expect(created.statusCode).toBe(201)
		expect(created.json()).toMatchObject({ title: 'Add search', status: 'queued', source: 'api' })

		const list = await app.inject({ url: '/tasks', headers })
		expect(list.json().tasks).toHaveLength(1)
		expect((await app.inject({ url: '/status', headers })).json().queued).toBe(1)

		const invalid = await app.inject({
			method: 'POST',
			url: '/tasks',
			headers,
			payload: { title: '' },
		})
		expect(invalid.statusCode).toBe(400)
	})

	it('Serves the audit log per day (today by default)', async () => {
		await app.inject({ method: 'POST', url: '/pause', headers })

		const today = await app.inject({ url: '/audit', headers })
		expect(today.json().day).toBe('2026-09-03')
		expect(today.json().entries.map((entry: { type: string }) => entry.type)).toEqual([
			'resident_started',
			'paused',
		])

		const other = await app.inject({ url: '/audit?day=2026-01-01', headers })
		expect(other.json()).toEqual({ day: '2026-01-01', entries: [] })
		expect((await app.inject({ url: '/audit?day=yesterday', headers })).statusCode).toBe(400)
	})
})
