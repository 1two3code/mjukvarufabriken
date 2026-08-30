import { resolveReportTarget } from '#/config.ts'

describe('resolveReportTarget', () => {
	it('Prefers the api (Fargate) over a database url', () => {
		expect(
			resolveReportTarget({
				API_URL: 'http://alb',
				JOB_TOKEN: 'tok',
				DATABASE_URL: 'postgres://x',
			})
		).toEqual({ mode: 'api', apiUrl: 'http://alb', token: 'tok' })
	})

	it('Falls back to the database for local runs', () => {
		expect(resolveReportTarget({ DATABASE_URL: 'postgres://mf:mf@localhost/mf' })).toEqual({
			mode: 'db',
			databaseUrl: 'postgres://mf:mf@localhost/mf',
		})
	})

	it('Refuses half an api configuration or nothing at all', () => {
		expect(() => resolveReportTarget({ API_URL: 'http://alb' })).toThrow(/together/)
		expect(() => resolveReportTarget({ JOB_TOKEN: 'tok' })).toThrow(/together/)
		expect(() => resolveReportTarget({})).toThrow(/required/)
	})
})
