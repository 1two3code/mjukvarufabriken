import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	citationExists,
	defaultSkeptics,
	isFalsePositive,
	RefuteOutputSchema,
	refuteOutputJsonSchema,
	resolveSkeptics,
	skepticSystemPrompt,
	tallyRefutations,
} from '#job/gates/review.ts'

import type { ReviewFinding, Spec } from '@mf/models'
import type { FindingVerdict } from '#job/gates/review.ts'

const spec: Spec = {
	goal: 'book classes',
	users: ['member'],
	features: [{ title: 'Schedule', description: '', acceptanceCriteria: ['book a class'] }],
	nonGoals: [],
	stackConstraints: [],
}

const finding = (over: Partial<ReviewFinding> = {}): ReviewFinding => ({
	id: 'apps/app/src/App.tsx:12',
	severity: 'high',
	file: 'apps/app/src/App.tsx',
	line: 12,
	claim: 'the user must type a raw UUID',
	failureScenario: 'a member cannot book because the field rejects a name',
	...over,
})

const ballot = (...entries: [string, FindingVerdict['verdict']][]): FindingVerdict[] =>
	entries.map(([id, verdict]) => ({ id, verdict }))

describe('resolveSkeptics', () => {
	it('Prefers an explicit override, then REVIEW_SKEPTICS, then the default', () => {
		expect(resolveSkeptics(1)).toBe(1)
		expect(resolveSkeptics(0)).toBe(0)
		expect(resolveSkeptics(2.9)).toBe(2)
		expect(resolveSkeptics(-3)).toBe(0)
		expect(resolveSkeptics(undefined, { REVIEW_SKEPTICS: '4' })).toBe(4)
		expect(resolveSkeptics(undefined, { REVIEW_SKEPTICS: '0' })).toBe(0)
		expect(resolveSkeptics(undefined, {})).toBe(defaultSkeptics)
		expect(resolveSkeptics(undefined, { REVIEW_SKEPTICS: 'nope' })).toBe(defaultSkeptics)
		expect(resolveSkeptics(undefined, { REVIEW_SKEPTICS: '-1' })).toBe(defaultSkeptics)
	})
})

describe('isFalsePositive', () => {
	it('Drops a finding only when a strict majority of skeptics refute it', () => {
		expect(isFalsePositive(['refuted', 'refuted', 'refuted'], 3)).toBe(true)
		expect(isFalsePositive(['refuted', 'refuted', 'upheld'], 3)).toBe(true)
		expect(isFalsePositive(['refuted', 'upheld', 'upheld'], 3)).toBe(false)
		// A tie keeps the finding — the gate fails closed, an unsubstantiated drop is riskier
		expect(isFalsePositive(['refuted', 'upheld'], 2)).toBe(false)
		expect(isFalsePositive(['refuted', 'refuted'], 2)).toBe(true)
		// Abstentions (missing votes) count toward keeping, not toward the majority
		expect(isFalsePositive(['refuted'], 3)).toBe(false)
		expect(isFalsePositive([], 3)).toBe(false)
		expect(isFalsePositive(['refuted', 'refuted'], 0)).toBe(false)
	})
})

describe('tallyRefutations', () => {
	const real = finding({ id: 'a.ts:1', file: 'a.ts', line: 1 })
	const hallucinated = finding({ id: 'b.ts:2', file: 'b.ts', line: 2 })

	it('Keeps upheld findings and drops the ones the skeptics refute, recording their votes', () => {
		const ballots = [
			ballot(['a.ts:1', 'upheld'], ['b.ts:2', 'refuted']),
			ballot(['a.ts:1', 'upheld'], ['b.ts:2', 'refuted']),
			ballot(['a.ts:1', 'refuted'], ['b.ts:2', 'upheld']),
		]

		const { kept, refuted } = tallyRefutations([real, hallucinated], ballots, 3)

		expect(kept).toEqual([real])
		expect(refuted).toHaveLength(1)
		expect(refuted[0]!.finding).toEqual(hallucinated)
		expect(refuted[0]!.votes).toEqual(['refuted', 'refuted', 'upheld'])
		expect(refuted[0]!.reason).toMatch(/majority/)
	})

	it('Treats a skeptic that omitted a finding as an abstention that keeps it', () => {
		// Only one of three skeptics ruled on the finding, and it refuted — not a majority
		const ballots = [ballot(['a.ts:1', 'refuted']), [], []]

		const { kept, refuted } = tallyRefutations([real], ballots, 3)

		expect(kept).toEqual([real])
		expect(refuted).toEqual([])
	})
})

describe('citationExists', () => {
	let repoDir: string
	beforeEach(async () => {
		repoDir = await mkdtemp(join(tmpdir(), 'mf-review-'))
		await writeFile(join(repoDir, 'real.ts'), 'export const a = 1\n')
	})
	afterEach(() => rm(repoDir, { recursive: true, force: true }))

	it('Is true for a file in the tree and false for a hallucinated or escaping path', async () => {
		expect(await citationExists(repoDir, finding({ file: 'real.ts' }))).toBe(true)
		expect(await citationExists(repoDir, finding({ file: 'ghost.ts' }))).toBe(false)
		expect(await citationExists(repoDir, finding({ file: '../secret.ts' }))).toBe(false)
		expect(await citationExists(repoDir, finding({ file: '/etc/passwd' }))).toBe(false)
		expect(await citationExists(repoDir, finding({ file: '   ' }))).toBe(false)
	})
})

describe('skepticSystemPrompt', () => {
	it('Is read-only, adversarial and lists every finding id to disprove', () => {
		const prompt = skepticSystemPrompt(spec, 'seed..HEAD', [
			finding({ id: 'a.ts:1', file: 'a.ts', line: 1 }),
		])
		expect(prompt).toContain('READ-ONLY')
		expect(prompt).toContain('DISPROVE')
		expect(prompt).toContain('git diff seed..HEAD')
		expect(prompt).toContain('- [a.ts:1] HIGH a.ts:1')
	})
})

describe('refuteOutputJsonSchema', () => {
	it('Parses a well-formed skeptic answer and is a plain JSON schema object', () => {
		const parsed = RefuteOutputSchema.safeParse({
			verdicts: [{ id: 'a.ts:1', verdict: 'refuted', reasoning: 'the cited lines do not exist' }],
		})
		expect(parsed.success).toBe(true)
		expect(RefuteOutputSchema.safeParse({ verdicts: [{ id: 'x', verdict: 'maybe' }] }).success).toBe(
			false
		)
		expect(typeof refuteOutputJsonSchema).toBe('object')
	})
})
