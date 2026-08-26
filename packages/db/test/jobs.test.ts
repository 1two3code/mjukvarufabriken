import { getJob, isUuid, listEvents, updateJob } from '#/jobs.ts'

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
})
