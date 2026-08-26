import { appRunnerServiceName } from '#job/delivery/appRunner.ts'
import {
	renderAcceptanceTable,
	renderGateTable,
	renderKnownLimitations,
	renderReadme,
} from '#job/delivery/docs.ts'
import { appNameOf, slugify } from '#job/delivery/index.ts'

import type { GateReport, Spec } from '@mf/models'

const spec: Spec = {
	goal: 'Book gym classes. Members only.',
	users: [],
	features: [{ title: 'Book', description: 'x', acceptanceCriteria: ['Can book', 'Can | cancel'] }],
	nonGoals: [],
	stackConstraints: [],
}

const gate = (overrides: Partial<GateReport>): GateReport => ({
	name: 'verify',
	ok: true,
	startedAt: '2026-08-26T10:00:00.000Z',
	durationMs: 12_400,
	tokens: 0,
	summary: 'lint + test green',
	...overrides,
})

describe('delivery docs', () => {
	it('Renders the gate table deterministically', () => {
		expect(renderGateTable([gate({}), gate({ name: 'review', ok: false, summary: 'a | b' })]))
			.toBe(`| Gate | Result | Duration | Tokens | Summary |
|---|---|---|---|---|
| verify | OK | 12 s | 0 | lint + test green |
| review | FAILED | 12 s | 0 | a \\| b |`)
		expect(renderGateTable([])).toBe('_No gate ran._')
	})

	it('Renders every criterion with unknown status when the report misses it', () => {
		const table = renderAcceptanceTable(spec, {
			'f0.c0': { status: 'met', evidence: ['a.test.ts', 'b.test.ts'] },
		})
		expect(table).toContain('| f0.c0 | Book | Can book | met | a.test.ts; b.test.ts |')
		expect(table).toContain('| f0.c1 | Book | Can \\| cancel | unknown | - |')
	})

	it('Lists only low findings (after the fix round when there was one) as known limitations', () => {
		const finding = (severity: string, line: number) => ({
			id: `f.ts:${line}`,
			severity,
			file: 'f.ts',
			line,
			claim: `claim ${line}`,
			failureScenario: 'x',
		})
		const gates = [
			gate({
				name: 'review',
				details: {
					findings: [finding('low', 1), finding('high', 2)],
					findingsAfterFix: [finding('low', 3)],
				},
			}),
		]
		expect(renderKnownLimitations(gates)).toBe('- `f.ts:3` — claim 3')
		expect(renderKnownLimitations([])).toMatch(/no open low-severity findings/)
	})

	it('Replaces the template README title and keeps the rest', () => {
		const readme = renderReadme('# Template\n\nIntro.\n\n## Commands\n', {
			spec,
			gates: [],
			jobId: 'j',
			target: { slug: 'gym', appName: 'Gym' },
		})
		expect(readme).toMatch(/^# Gym\n\nBook gym classes\. Members only\.\n/)
		expect(readme).toContain('https://github.com/mjukvaruhuset/gym')
		expect(readme).toContain('Intro.\n\n## Commands')
		expect(readme).not.toContain('# Template')
	})

	it('Derives slug, app name and App Runner service name', () => {
		expect(slugify('Gym Booking — Åre Fitness!')).toBe('gym-booking-are-fitness')
		expect(slugify('***')).toBe('app')
		expect(slugify('x'.repeat(80))).toHaveLength(60)
		expect(appNameOf('a booking app for a gym. With payments.')).toBe('A booking app for a gym')
		expect(appNameOf('')).toBe('Your application')
		expect(appNameOf('y'.repeat(100))).toHaveLength(78)
		expect(appRunnerServiceName('mf-gym-booking-11111111')).toBe('mf-gym-booking-11111111')
		expect(appRunnerServiceName('--a.b')).toBe('a-b0')
		expect(appRunnerServiceName('z'.repeat(50))).toHaveLength(40)
	})
})
