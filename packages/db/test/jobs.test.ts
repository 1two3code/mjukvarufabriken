import { getJob, getJobByReportToken, isUuid, listEvents, toJob, updateJob } from '#/jobs.ts'

import type { Db } from '#/index.ts'

/** A Db whose sql throws on use: the guards must return before touching Postgres */
const untouchable = {
	sql: () => {
		throw new Error('sql must not be called')
	},
} as unknown as Db

describe('jobs repository', () => {
	it('isUuid accepts canonical uuids only', () => {
		expect(isUuid('0b5c1d3e-9a7f-4c2b-8e1d-2f3a4b5c6d7e')).toBe(true)
		expect(isUuid('0B5C1D3E-9A7F-4C2B-8E1D-2F3A4B5C6D7E')).toBe(true)
		expect(isUuid('abc')).toBe(false)
		expect(isUuid('')).toBe(false)
		expect(isUuid("' or 1=1 --")).toBe(false)
	})

	it('Treats a malformed id as not found without querying', async () => {
		await expect(getJob(untouchable, 'abc')).resolves.toBeUndefined()
		await expect(updateJob(untouchable, 'abc', { status: 'failed' })).resolves.toBeUndefined()
		await expect(listEvents(untouchable, 'abc')).resolves.toEqual([])
	})

	it('Treats an empty report token hash as not found without querying', async () => {
		await expect(getJobByReportToken(untouchable, '')).resolves.toBeUndefined()
	})

	it('Maps gates and gate_waivers from the row (waivers reach the orchestrator)', () => {
		const report = {
			name: 'review' as const,
			ok: true,
			startedAt: '2026-08-26T10:00:00.000Z',
			durationMs: 5,
			tokens: 1,
			summary: 'ok',
		}
		const row = {
			id: '0b5c1d3e-9a7f-4c2b-8e1d-2f3a4b5c6d7e',
			order_id: 'o',
			org_id: 'g',
			status: 'delivered' as const,
			spec: {} as never,
			budget_tokens: 1,
			tokens_used: 0,
			max_workers: 1,
			max_duration_minutes: 1,
			plan: null,
			reason: null,
			gates: [report],
			gate_waivers: ['apps/api/src/x.ts:12'],
			task_arn: null,
			repository_url: null,
			report_token_hash: null,
			awaiting_approval: false,
			approved: false,
			started_at: null,
			finished_at: null,
			created_at: new Date(0),
		}

		expect(toJob(row)).toMatchObject({ gates: [report], gateWaivers: ['apps/api/src/x.ts:12'] })
		expect(toJob({ ...row, gates: null, gate_waivers: [] })).toMatchObject({
			gates: undefined,
			gateWaivers: undefined,
		})
	})
})
