import { evaluateVitestReport } from '#job/worker.ts'

const files = ['apps/app/src/acceptance/f0.c0.test.tsx', 'apps/api/test/acceptance/f1.c0.test.ts']

const passed = (name: string, tests = 1) => ({
	name: `/work/repo/${name}`,
	status: 'passed',
	assertionResults: Array.from({ length: tests }, (_, i) => ({
		fullName: `[${name}] ${i}`,
		status: 'passed',
	})),
})

describe('evaluateVitestReport', () => {
	it('Is green only when every acceptance file ran with passing tests', () => {
		const report = { success: true, testResults: files.map(file => passed(file)) }
		expect(evaluateVitestReport(report, files)).toEqual({
			ok: true,
			output: '2 acceptance test file(s) executed and green',
		})
	})

	it('Is red when a file was not executed (no project picked it up)', () => {
		const report = { success: true, testResults: [passed(files[1]!)] }
		expect(evaluateVitestReport(report, files)).toEqual({
			ok: false,
			output: `acceptance tests not green:\n${files[0]}: not executed`,
		})
	})

	it('Is red on an empty file or a failing/skipped test', () => {
		const empty = { ...passed(files[0]!), assertionResults: [] }
		const failing = {
			...passed(files[1]!),
			status: 'failed',
			assertionResults: [{ fullName: '[f1.c0] cancel', status: 'failed' }],
		}
		const outcome = evaluateVitestReport({ testResults: [empty, failing] }, files)
		expect(outcome.ok).toBe(false)
		expect(outcome.output).toContain(`${files[0]}: no tests`)
		expect(outcome.output).toContain(`${files[1]}: [f1.c0] cancel failed`)

		const skipped = {
			...passed(files[0]!),
			assertionResults: [{ fullName: 'x', status: 'skipped' }],
		}
		expect(evaluateVitestReport({ testResults: [skipped, passed(files[1]!)] }, files).ok).toBe(
			false
		)
	})
})
