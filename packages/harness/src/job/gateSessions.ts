import { readdir, rm } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'

import { z } from 'zod'
import { AcceptanceReportSchema, ReviewFindingSchema } from '@mf/models'

import { exec, tail } from './exec.ts'
import {
	citationExists,
	RefuteOutputSchema,
	refuteOutputJsonSchema,
	resolveSkeptics,
	skepticPrompt,
	skepticSystemPrompt,
	tallyRefutations,
} from './gates/review.ts'
import { renderFencedSpec } from './planner.ts'
import { totalTokens } from './types.ts'
import {
	readOnlyTools,
	repoConventions,
	runAcceptanceTests,
	runSession,
	verifyRepo,
} from './worker.ts'

import type { FindingVerdict, RefuteResult } from './gates/review.ts'
import type { AcceptanceReport, ReviewFinding, Spec } from '@mf/models'
import type { GateInput, GateOutcome, TokenUsage } from './types.ts'

// MARK: Criteria

export type Criterion = { id: string; feature: string; text: string }

/** Every acceptance criterion of the spec with its plan id (`f<feature>.c<criterion>`) */
export const criteriaOf = (spec: Spec): Criterion[] =>
	spec.features.flatMap((feature, f) =>
		feature.acceptanceCriteria.map((text, c) => ({
			id: `f${f}.c${c}`,
			feature: feature.title,
			text,
		}))
	)

const renderCriteria = (criteria: Criterion[]) =>
	criteria
		.map(criterion => `- [${criterion.id}] (${criterion.feature}) ${criterion.text}`)
		.join('\n')

// MARK: Repo helpers

/** Directories named `acceptance` under apps/*, where the gate session writes its tests */
export const findAcceptanceDirs = async (repoDir: string): Promise<string[]> => {
	const found: string[] = []
	const walk = async (dir: string, depth: number) => {
		if (depth > 4) return
		let entries
		try {
			entries = await readdir(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) {
				continue
			}
			const full = join(dir, entry.name)
			if (entry.name === 'acceptance') found.push(full)
			else await walk(full, depth + 1)
		}
	}
	await walk(join(repoDir, 'apps'), 0)
	return found
}

/** Repo-relative acceptance test files per criterion id (`<id>.test.ts[x]`) */
export const findAcceptanceTests = async (repoDir: string, criteria: Criterion[]) => {
	const files = new Map<string, string[]>(criteria.map(criterion => [criterion.id, []]))
	for (const dir of await findAcceptanceDirs(repoDir)) {
		for (const name of await readdir(dir)) {
			const id = name.replace(/\.test\.tsx?$/, '')
			if (id !== name && files.has(id)) files.get(id)!.push(relative(repoDir, join(dir, name)))
		}
	}
	return files
}

const commitAll = async (repoDir: string, message: string, signal: AbortSignal) => {
	await exec('git', ['add', '-A'], { cwd: repoDir, signal })
	await exec('git', ['commit', '-q', '-m', message], { cwd: repoDir, signal })
}

export type RepoSnapshot = { head: string; branch?: string }

/** HEAD + branch before a read-only session, so anything it does to git can be undone */
export const snapshotRepo = async (repoDir: string): Promise<RepoSnapshot> => {
	const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim()
	const ref = (
		await exec('git', ['symbolic-ref', '-q', '--short', 'HEAD'], { cwd: repoDir })
	).stdout.trim()
	return { head, branch: ref || undefined }
}

/**
 * Throws away anything a read-only session left behind — it must never change the repo, but its
 * Bash is only restricted by prompt: the branch is checked out again, HEAD is reset hard to the
 * snapshot (undoes commits, resets, stashes, detached heads) and untracked files are removed.
 * Returns true when git state (not just the working tree) had been changed.
 */
export const discardChanges = async (repoDir: string, snapshot?: RepoSnapshot) => {
	let moved = false
	if (snapshot) {
		const current = await snapshotRepo(repoDir)
		moved = current.head !== snapshot.head || current.branch !== snapshot.branch
		if (snapshot.branch) {
			await exec('git', ['checkout', '-q', '-f', snapshot.branch], { cwd: repoDir })
		}
		await exec('git', ['reset', '-q', '--hard', snapshot.head], { cwd: repoDir })
	}
	await exec('git', ['checkout', '-q', '--', '.'], { cwd: repoDir })
	await exec('git', ['clean', '-qfd'], { cwd: repoDir })
	if (moved) {
		console.warn(JSON.stringify({ message: 'read-only session changed git state', repoDir }))
	}
	return moved
}

/**
 * Files an acceptance fix session must not touch: the tests themselves, and everything that
 * decides whether they run — Vitest configs/workspaces, package.json scripts, test setup files.
 */
export const isProtectedTestPath = (path: string) => {
	const name = basename(path)
	return (
		/(^|\/)acceptance\//.test(path) ||
		/^(vitest|vite)\.(config|workspace)\./.test(name) ||
		name === 'package.json' ||
		/^setup(-?tests?)?\./i.test(name) ||
		/(^|\/)test\/setup/.test(path)
	)
}

/**
 * Restores every protected path to how it was in `commit` (recreates, reverts or deletes) and
 * returns the paths that had been changed.
 */
export const restoreProtectedPaths = async (
	repoDir: string,
	commit: string,
	signal: AbortSignal
) => {
	const opts = { cwd: repoDir, signal }
	const tracked = (await exec('git', ['diff', '--name-only', commit], opts)).stdout
	const untracked = (await exec('git', ['ls-files', '--others', '--exclude-standard'], opts)).stdout
	const changed = [
		...new Set(
			`${tracked}\n${untracked}`
				.split('\n')
				.map(line => line.trim())
				.filter(Boolean)
		),
	]
	const restored: string[] = []
	for (const path of changed.filter(isProtectedTestPath)) {
		const existed = (await exec('git', ['cat-file', '-e', `${commit}:${path}`], opts)).code === 0
		if (existed) await exec('git', ['checkout', '-q', commit, '--', path], opts)
		else await rm(join(repoDir, path), { force: true })
		restored.push(path)
	}
	return restored
}

/** Lint + test of the whole repo, then the acceptance files explicitly — both must be green */
const verifyAcceptance = async (repoDir: string, files: string[], signal: AbortSignal) => {
	const verification = await verifyRepo(repoDir, signal)
	if (!verification.ok) return verification
	return runAcceptanceTests(repoDir, files, signal)
}

const rootCommit = async (repoDir: string, signal: AbortSignal) => {
	const result = await exec('git', ['rev-list', '--max-parents=0', 'HEAD'], {
		cwd: repoDir,
		signal,
	})
	return result.stdout.trim().split('\n')[0] || 'HEAD'
}

const usageCounter = (onUsage: (usage: TokenUsage) => void) => {
	let tokens = 0
	const count = (usage: TokenUsage) => {
		tokens += totalTokens(usage)
		onUsage(usage)
	}
	return { count, tokens: () => tokens }
}

const readOnlyRule = `You are READ-ONLY: never create, edit, move or delete files, never run commands that change the working tree or git state (no git add/commit/checkout/reset, no npm install, no formatters with --write). Bash is for inspection only (git diff/log/show, npm test, grep, cat).`

export type LiveGateOptions = { model?: string }

/** Review gate options: the model, plus how many adversarial skeptics vote on the findings */
export type ReviewGateOptions = LiveGateOptions & { skeptics?: number }

// MARK: Gate 1 — acceptance tests from criteria

export const acceptanceTestsSystemPrompt = (spec: Spec, criteria: Criterion[]) =>
	`You are the QA engineer at Mjukvaruhuset. The application below has just been built from a frozen spec; every task is merged into main and lint + tests are green. Your job is to write ONE acceptance test per acceptance criterion and make them pass by exercising the app — NOT by changing the app's behaviour.

# Where the tests go
- UI criteria: apps/app/src/acceptance/<criterion id>.test.tsx using Vitest + @testing-library/react (jsdom).
- Server-side criteria (api routes/services): apps/api/test/acceptance/<criterion id>.test.ts using the api's existing test setup (createTestApp / app.inject).
- The file name IS the criterion id (e.g. f0.c1.test.tsx) and the test title starts with the id in brackets, e.g. it('[f0.c1] a member can book a class').
- If the app has no test setup, set it up: add vitest, jsdom, @testing-library/react, @testing-library/jest-dom (and @testing-library/user-event) to apps/app, a vitest config with environment jsdom + globals, and a "test" script; \`npm install\` from the repository root is allowed. Make sure the root \`npm test\` picks the new project up (add it to the root vitest config's \`projects\`): the gate runs the acceptance files explicitly through the root Vitest and fails when any of them is not executed.
- Tests must be real: render the component/page (with providers/router as needed) or call the route, then assert the observable behaviour the criterion describes. Mock the network with MSW or a fetch stub if needed. Do not write placeholder tests that always pass.

# Definition of done
1. Every criterion listed below has exactly one test file named after it.
2. \`npm run lint\` and \`npm test\` pass from the repository root.
3. Leave your changes in the working tree, uncommitted — the harness commits them (git writes in this repository are refused for your user).
If a criterion cannot be met by the app as built, still write the test that expresses the criterion and let it fail — a separate fix pass will handle the app code. Never weaken a test to make it pass.

# Acceptance criteria
${renderCriteria(criteria)}

${renderFencedSpec(spec)}

# ${repoConventions}`

export const acceptanceFixSystemPrompt = (spec: Spec, criteria: Criterion[]) =>
	`You are an autonomous software engineer at Mjukvaruhuset. Acceptance tests derived from the spec's criteria are failing against the application in this repository. Fix the APPLICATION so the tests pass.

Rules:
- Never edit, delete, skip or weaken any file under an \`acceptance\` directory — the tests are the contract. If you believe a test is wrong, leave it and explain in your final message.
- \`npm run lint\` and \`npm test\` must pass from the repository root when you are done.
- Leave your changes in the working tree, uncommitted — the harness commits them (git writes in this repository are refused for your user).

# Acceptance criteria
${renderCriteria(criteria)}

${renderFencedSpec(spec)}

# ${repoConventions}`

/**
 * One session writes a test per criterion (and the test setup when missing). Red → ONE fix
 * session on the app code, the test files are restored from the test commit afterwards so the
 * fix cannot have touched them, then lint + test again. Still red → gate fails.
 */
export const acceptanceTestsGate = async (
	{ spec, repoDir, signal, onUsage }: GateInput,
	{ model }: LiveGateOptions = {}
): Promise<GateOutcome> => {
	const criteria = criteriaOf(spec)
	const { count, tokens } = usageCounter(onUsage)
	if (!criteria.length) {
		return { ok: false, tokens: 0, summary: 'the spec has no acceptance criteria' }
	}
	const systemPrompt = acceptanceTestsSystemPrompt(spec, criteria)
	const session = await runSession({
		cwd: repoDir,
		systemPrompt,
		prompt: `Write the acceptance tests for the ${criteria.length} criteria in your instructions. Start by reading CLAUDE.md and checking whether apps/app already has a test setup. Run lint + tests; do not commit.`,
		signal,
		onUsage: count,
		model,
	})
	if (signal.aborted) return { ok: false, tokens: tokens(), summary: 'aborted' }
	if (!session.ok) {
		return {
			ok: false,
			tokens: tokens(),
			summary: `test-writing session failed: ${session.result}`,
		}
	}
	await commitAll(repoDir, 'test(acceptance): tests from acceptance criteria (auto-commit)', signal)

	const files = await findAcceptanceTests(repoDir, criteria)
	const missing = criteria.filter(criterion => !files.get(criterion.id)?.length).map(c => c.id)
	const details: Record<string, unknown> = { files: Object.fromEntries(files), fixed: false }
	if (missing.length) {
		return {
			ok: false,
			tokens: tokens(),
			summary: `no acceptance test written for: ${missing.join(', ')}`,
			details,
		}
	}

	const testFiles = [...files.values()].flat()
	let verification = await verifyAcceptance(repoDir, testFiles, signal)
	if (!verification.ok) {
		const testsCommit = (
			await exec('git', ['rev-parse', 'HEAD'], { cwd: repoDir, signal })
		).stdout.trim()
		const fix = await runSession({
			cwd: repoDir,
			systemPrompt: acceptanceFixSystemPrompt(spec, criteria),
			prompt: `The acceptance tests fail. Fix the application (never the tests) so that \`npm run lint\` and \`npm test\` pass; do not commit.\n\n${verification.output}`,
			signal,
			onUsage: count,
			model,
			maxTurns: 120,
		})
		details.fixed = true
		if (signal.aborted) return { ok: false, tokens: tokens(), summary: 'aborted', details }
		if (!fix.ok) {
			return { ok: false, tokens: tokens(), summary: `fix session failed: ${fix.result}`, details }
		}
		// The tests are the contract: whatever the fix did to them, or to what makes them run
		// (vitest config, package.json scripts, setup files), is undone
		details.restored = await restoreProtectedPaths(repoDir, testsCommit, signal)
		await commitAll(repoDir, 'fix(acceptance): make acceptance tests pass (auto-commit)', signal)
		verification = await verifyAcceptance(repoDir, testFiles, signal)
		if (signal.aborted) return { ok: false, tokens: tokens(), summary: 'aborted', details }
		if (!verification.ok) {
			return {
				ok: false,
				tokens: tokens(),
				summary: `acceptance tests still red after one fix:\n${tail(verification.output, 40)}`,
				details,
			}
		}
	}
	return {
		ok: true,
		tokens: tokens(),
		summary: `${criteria.length} acceptance test(s) green${details.fixed ? ' after one fix' : ''}`,
		details,
	}
}

// MARK: Gate 2 — independent review

/** What the review session returns (ids are assigned by the harness, not the model) */
export const ReviewOutputSchema = z.object({
	findings: z.array(ReviewFindingSchema.omit({ id: true })),
})
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>

export const reviewOutputJsonSchema = z.toJSONSchema(ReviewOutputSchema) as Record<string, unknown>

// A finding's id is its LOCATION (file:line) on purpose: waivers waive a location and the gate
// message prints it. Two distinct findings at the same file:line therefore share an id (the refute
// tally would apply one verdict to both) — a rare edge case, left as a known limitation so the
// waiver/display semantics stay location-based.
export const findingId = (finding: Omit<ReviewFinding, 'id'>) => `${finding.file}:${finding.line}`

export const reviewSystemPrompt = (spec: Spec, range: string) =>
	`You are the independent reviewer at Mjukvaruhuset. Autonomous workers built the application in this repository from the spec below; you review their work for CORRECTNESS and SECURITY before it is delivered to the customer. You did not write any of it and you have no stake in it passing.

${readOnlyRule}

Review \`git diff ${range}\` (plus any context you need from the tree). Report only real defects a reader can verify: wrong behaviour against the spec, data loss, crashes, race conditions, broken auth/permission checks, injection, secrets in code, unsafe defaults. Style, naming and hypothetical concerns are not findings.

Severity: high = wrong result, data loss, or exploitable; medium = a defect a user will hit but with a workaround; low = minor / defensive. For every finding give the file (repo-relative), the line in the current tree, a one-sentence claim and the concrete failure scenario (input → wrong output).

Finish by returning the findings as the structured output; an empty list is a valid answer when the change is sound.

${renderFencedSpec(spec)}`

export const reviewFixSystemPrompt = (spec: Spec, findings: ReviewFinding[]) =>
	`You are an autonomous software engineer at Mjukvaruhuset. An independent review of the application in this repository found the defects below. Fix every one of them properly (no suppressions, no deleted tests, no weakened checks).

# Findings
${findings.map(f => `- [${f.id}] ${f.severity.toUpperCase()} ${f.file}:${f.line} — ${f.claim}\n  Failure scenario: ${f.failureScenario}`).join('\n')}

# Definition of done
1. Every finding above is fixed.
2. \`npm run lint\` and \`npm test\` pass from the repository root.
3. Leave your changes in the working tree, uncommitted — the harness commits them (git writes in this repository are refused for your user).

${renderFencedSpec(spec)}

# ${repoConventions}`

const reviewSession = async (
	input: GateInput,
	range: string,
	count: (usage: TokenUsage) => void,
	model?: string
) => {
	const snapshot = await snapshotRepo(input.repoDir)
	const session = await runSession({
		cwd: input.repoDir,
		systemPrompt: reviewSystemPrompt(input.spec, range),
		prompt: `Review \`git diff ${range}\` for correctness and security and return your findings.`,
		signal: input.signal,
		onUsage: count,
		model,
		maxTurns: 120,
		tools: readOnlyTools,
		outputSchema: reviewOutputJsonSchema,
	})
	await discardChanges(input.repoDir, snapshot)
	if (!session.ok) throw new Error(`review session failed: ${session.result}`)
	const parsed = ReviewOutputSchema.safeParse(session.structuredOutput)
	if (!parsed.success) throw new Error(`review output invalid: ${parsed.error.message}`)
	return parsed.data.findings.map(finding => ({ ...finding, id: findingId(finding) }))
}

const isActionable = (finding: ReviewFinding, waivers: string[]) =>
	finding.severity !== 'low' && !waivers.includes(finding.id)

// MARK: Adversarial refute pass

/** One skeptic session: read-only, disproves the findings, discards anything it left behind */
const skepticSession = async (
	input: GateInput,
	range: string,
	findings: ReviewFinding[],
	count: (usage: TokenUsage) => void,
	model?: string
): Promise<FindingVerdict[]> => {
	const snapshot = await snapshotRepo(input.repoDir)
	const session = await runSession({
		cwd: input.repoDir,
		systemPrompt: skepticSystemPrompt(input.spec, range, findings),
		prompt: skepticPrompt(range),
		signal: input.signal,
		onUsage: count,
		model,
		maxTurns: 60,
		tools: readOnlyTools,
		outputSchema: refuteOutputJsonSchema,
	})
	await discardChanges(input.repoDir, snapshot)
	if (!session.ok) return []
	const parsed = RefuteOutputSchema.safeParse(session.structuredOutput)
	return parsed.success ? parsed.data.verdicts : []
}

/**
 * Verify every finding against the actual code before it can fail the gate. First a deterministic
 * pass drops findings whose cited file does not exist in the tree (a hallucinated citation). Then
 * `skeptics` independent adversaries each try to disprove the survivors by reading the cited
 * lines; a finding a majority refutes is dropped. Everything dropped is counted as a false
 * positive. Runs `skeptics` sessions total (each votes on all findings), regardless of how many
 * findings there are; skips the sessions entirely when nothing survives the citation check.
 */
export const refuteFindings = async (
	input: GateInput,
	range: string,
	findings: ReviewFinding[],
	count: (usage: TokenUsage) => void,
	options: { model?: string; skeptics: number }
): Promise<RefuteResult> => {
	if (!findings.length) return { kept: [], refuted: [] }
	const cited: ReviewFinding[] = []
	const refuted: RefuteResult['refuted'] = []
	for (const finding of findings) {
		if (await citationExists(input.repoDir, finding)) cited.push(finding)
		else refuted.push({ finding, reason: 'cited file does not exist in the tree', votes: [] })
	}

	const { skeptics } = options
	if (cited.length && skeptics > 0) {
		const ballots: FindingVerdict[][] = []
		for (let index = 0; index < skeptics; index += 1) {
			if (input.signal.aborted) break
			ballots.push(await skepticSession(input, range, cited, count, options.model))
		}
		const tally = tallyRefutations(cited, ballots, skeptics)
		return { kept: tally.kept, refuted: [...refuted, ...tally.refuted] }
	}
	return { kept: cited, refuted }
}

/** Runs the refute pass, logs the false-positive count, and folds it into the gate's details */
const applyRefutePass = async (
	input: GateInput,
	range: string,
	findings: ReviewFinding[],
	count: (usage: TokenUsage) => void,
	options: { model?: string; skeptics: number },
	stage: 'initial' | 'after-fix'
): Promise<RefuteResult> => {
	const result = await refuteFindings(input, range, findings, count, options)
	if (result.refuted.length) {
		console.warn(
			JSON.stringify({
				message: 'review refute pass dropped false positives',
				stage,
				skeptics: options.skeptics,
				reviewed: findings.length,
				kept: result.kept.length,
				falsePositives: result.refuted.length,
				refuted: result.refuted.map(entry => ({
					id: entry.finding.id,
					severity: entry.finding.severity,
					claim: entry.finding.claim,
					reason: entry.reason,
					votes: entry.votes,
				})),
			})
		)
	}
	return result
}

/** The false positives, shaped for a gate's `details` (no full finding object, just the essentials) */
const refutedForDetails = (refuted: RefuteResult['refuted']) =>
	refuted.map(entry => ({
		id: entry.finding.id,
		severity: entry.finding.severity,
		claim: entry.finding.claim,
		reason: entry.reason,
		votes: entry.votes,
	}))

// MARK: Waiver line mapping

export type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number }

/** Hunk headers of a `git diff -U0` for one file */
export const parseHunks = (diff: string): Hunk[] =>
	[...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(match => ({
		oldStart: Number(match[1]),
		oldCount: match[2] === undefined ? 1 : Number(match[2]),
		newStart: Number(match[3]),
		newCount: match[4] === undefined ? 1 : Number(match[4]),
	}))

/**
 * Where line `line` of the old file is in the new file: shifted by the hunks above it, moved
 * along inside a modified hunk, `undefined` when the hunk deleted it.
 */
export const remapLine = (hunks: Hunk[], line: number): number | undefined => {
	let offset = 0
	for (const hunk of hunks) {
		// A pure insertion (`-N,0`) sits after old line N; N itself is untouched
		if (line < hunk.oldStart || (hunk.oldCount === 0 && line <= hunk.oldStart)) break
		const end = hunk.oldStart + hunk.oldCount - 1
		if (line <= end) {
			if (hunk.newCount === 0) return undefined
			return hunk.newStart + Math.min(line - hunk.oldStart, hunk.newCount - 1)
		}
		offset += hunk.newCount - hunk.oldCount
	}
	return line + offset
}

const parseWaiver = (waiver: string) => {
	const match = /^(.+):(\d+)$/.exec(waiver)
	return match ? { file: match[1]!, line: Number(match[2]) } : undefined
}

/**
 * Waivers are `<file>:<line>` in the tree the admin looked at; after the fix session moved lines
 * around they are translated through `git diff -U0 <before>..HEAD` so they keep pointing at the
 * same code (and stop matching whatever now sits at the old line number).
 */
export const remapWaivers = async (
	repoDir: string,
	waivers: string[],
	before: string,
	signal: AbortSignal
) => {
	const hunksByFile = new Map<string, Hunk[]>()
	const mapped: string[] = []
	for (const waiver of waivers) {
		const parsed = parseWaiver(waiver)
		if (!parsed) {
			mapped.push(waiver)
			continue
		}
		let hunks = hunksByFile.get(parsed.file)
		if (!hunks) {
			const diff = await exec('git', ['diff', '-U0', before, 'HEAD', '--', parsed.file], {
				cwd: repoDir,
				signal,
			})
			hunks = parseHunks(diff.stdout)
			hunksByFile.set(parsed.file, hunks)
		}
		const line = remapLine(hunks, parsed.line)
		if (line !== undefined) mapped.push(`${parsed.file}:${line}`)
	}
	return mapped
}

/**
 * Read-only review session → strict findings. High/medium (unwaived) → ONE fix session, lint +
 * test, then a second read-only review; any unwaived high finding still open fails the gate.
 * Low findings are recorded, never fixed.
 */
export const reviewGate = async (
	input: GateInput,
	{ model, skeptics: skepticOption }: ReviewGateOptions = {}
): Promise<GateOutcome> => {
	const { repoDir, signal, waivers, onUsage } = input
	const { count, tokens } = usageCounter(onUsage)
	const skeptics = resolveSkeptics(skepticOption)
	const refuteOptions = { model, skeptics }
	const seed = input.seedCommit ?? (await rootCommit(repoDir, signal))
	const range = `${seed}..HEAD`

	let reviewed: ReviewFinding[]
	try {
		reviewed = await reviewSession(input, range, count, model)
	} catch (error) {
		if (signal.aborted) return { ok: false, tokens: tokens(), summary: 'aborted' }
		return { ok: false, tokens: tokens(), summary: (error as Error).message }
	}
	if (signal.aborted) return { ok: false, tokens: tokens(), summary: 'aborted' }

	// Verify every finding against the actual code before it can fail the gate: hallucinated
	// citations and findings the skeptics refute are dropped and counted as false positives.
	const refutePass = await applyRefutePass(input, range, reviewed, count, refuteOptions, 'initial')
	if (signal.aborted) return { ok: false, tokens: tokens(), summary: 'aborted' }
	const findings = refutePass.kept
	let falsePositives = refutePass.refuted.length

	const details: Record<string, unknown> = {
		range,
		findings,
		waived: findings.filter(f => waivers.includes(f.id)).map(f => f.id),
		skeptics,
		falsePositives,
		refuted: refutedForDetails(refutePass.refuted),
		fixed: false,
	}
	const actionable = findings.filter(finding => isActionable(finding, waivers))
	if (!actionable.length) {
		return {
			ok: true,
			tokens: tokens(),
			summary:
				`${findings.length} finding(s), none high/medium open` +
				(falsePositives ? ` (${falsePositives} false positive(s) refuted)` : ''),
			details,
		}
	}

	const beforeFix = (
		await exec('git', ['rev-parse', 'HEAD'], { cwd: repoDir, signal })
	).stdout.trim()
	const fix = await runSession({
		cwd: repoDir,
		systemPrompt: reviewFixSystemPrompt(input.spec, actionable),
		prompt: `Fix the ${actionable.length} review finding(s) in your instructions, run lint + tests; do not commit.`,
		signal,
		onUsage: count,
		model,
		maxTurns: 120,
	})
	details.fixed = true
	if (signal.aborted) return { ok: false, tokens: tokens(), summary: 'aborted', details }
	if (!fix.ok) {
		return { ok: false, tokens: tokens(), summary: `fix session failed: ${fix.result}`, details }
	}
	await commitAll(repoDir, 'fix(review): address review findings (auto-commit)', signal)
	const verification = await verifyRepo(repoDir, signal)
	if (signal.aborted) return { ok: false, tokens: tokens(), summary: 'aborted', details }
	if (!verification.ok) {
		return {
			ok: false,
			tokens: tokens(),
			summary: `lint/test red after the review fix:\n${tail(verification.output, 40)}`,
			details,
		}
	}

	const waiversAfterFix = await remapWaivers(repoDir, waivers, beforeFix, signal)
	details.waiversAfterFix = waiversAfterFix
	let reviewedAfterFix: ReviewFinding[]
	try {
		reviewedAfterFix = await reviewSession(input, range, count, model)
	} catch (error) {
		if (signal.aborted) return { ok: false, tokens: tokens(), summary: 'aborted', details }
		return { ok: false, tokens: tokens(), summary: (error as Error).message, details }
	}
	if (signal.aborted) return { ok: false, tokens: tokens(), summary: 'aborted', details }

	// A high finding must survive the refute pass too before it re-fails the gate closed.
	const refuteAfterFix = await applyRefutePass(
		input,
		range,
		reviewedAfterFix,
		count,
		refuteOptions,
		'after-fix'
	)
	if (signal.aborted) return { ok: false, tokens: tokens(), summary: 'aborted', details }
	const afterFix = refuteAfterFix.kept
	falsePositives += refuteAfterFix.refuted.length
	details.findingsAfterFix = afterFix
	details.falsePositives = falsePositives
	details.falsePositivesAfterFix = refuteAfterFix.refuted.length
	details.refutedAfterFix = refutedForDetails(refuteAfterFix.refuted)
	const openHigh = afterFix.filter(f => f.severity === 'high' && !waiversAfterFix.includes(f.id))
	if (openHigh.length) {
		return {
			ok: false,
			tokens: tokens(),
			summary: `${openHigh.length} high finding(s) still open after one fix: ${openHigh.map(f => `${f.id} ${f.claim}`).join('; ')}`,
			details,
		}
	}
	return {
		ok: true,
		tokens: tokens(),
		summary:
			`${actionable.length} finding(s) fixed, ${afterFix.length} remaining (no open high)` +
			(falsePositives ? `, ${falsePositives} false positive(s) refuted` : ''),
		details,
	}
}

// MARK: Gate 3 — acceptance check

export const acceptanceReportJsonSchema = z.toJSONSchema(
	z.object({ report: AcceptanceReportSchema })
) as Record<string, unknown>

export const acceptanceCheckSystemPrompt = (spec: Spec, criteria: Criterion[]) =>
	`You are the acceptance checker at Mjukvaruhuset. Before the application in this repository is delivered, every acceptance criterion of the spec must be mapped to evidence that it is met.

${readOnlyRule}

For EACH criterion id below:
- Find the acceptance test(s) written for it (files named <id>.test.ts[x] under an \`acceptance\` directory), confirm they pass (\`npm test\` — read the output), and read what they assert.
- evidence: the repo-relative test file path(s) and, for UI criteria, one short sentence of what the test asserts (e.g. "renders the week schedule and disables the book button when the class is full").
- status: "met" only when a passing test genuinely covers the criterion's behaviour; "unmet" when the test fails, is missing, or does not cover the behaviour; "unknown" when you cannot tell.
Do not be generous: a placeholder test or a test asserting something unrelated is "unmet".

Return the structured output { report: { "<id>": { evidence: [...], status } } } with every id present.

# Acceptance criteria
${renderCriteria(criteria)}

${renderFencedSpec(spec)}`

/** Read-only session → Zod-validated `AcceptanceReport`; any unmet/unknown/missing criterion fails */
export const acceptanceCheckGate = async (
	{ spec, repoDir, signal, onUsage }: GateInput,
	{ model }: LiveGateOptions = {}
): Promise<GateOutcome> => {
	const criteria = criteriaOf(spec)
	const { count, tokens } = usageCounter(onUsage)
	const snapshot = await snapshotRepo(repoDir)
	const session = await runSession({
		cwd: repoDir,
		systemPrompt: acceptanceCheckSystemPrompt(spec, criteria),
		prompt: `Map the ${criteria.length} acceptance criteria to evidence and return the report.`,
		signal,
		onUsage: count,
		model,
		maxTurns: 100,
		tools: readOnlyTools,
		outputSchema: acceptanceReportJsonSchema,
	})
	await discardChanges(repoDir, snapshot)
	if (signal.aborted) return { ok: false, tokens: tokens(), summary: 'aborted' }
	if (!session.ok) {
		return {
			ok: false,
			tokens: tokens(),
			summary: `acceptance-check session failed: ${session.result}`,
		}
	}
	const parsed = z.object({ report: AcceptanceReportSchema }).safeParse(session.structuredOutput)
	if (!parsed.success) {
		return {
			ok: false,
			tokens: tokens(),
			summary: `acceptance report invalid: ${parsed.error.message}`,
		}
	}
	return evaluateAcceptanceReport(criteria, parsed.data.report, tokens())
}

/** Pure verdict on a report: every criterion must be present and `met` */
export const evaluateAcceptanceReport = (
	criteria: Criterion[],
	report: AcceptanceReport,
	tokens = 0
): GateOutcome => {
	const complete: AcceptanceReport = Object.fromEntries(
		criteria.map(criterion => [
			criterion.id,
			report[criterion.id] ?? { evidence: [], status: 'unknown' },
		])
	)
	const notMet = Object.entries(complete).filter(([, entry]) => entry.status !== 'met')
	const details = { report: complete }
	if (notMet.length) {
		return {
			ok: false,
			tokens,
			summary: `${notMet.length} criterion(s) not met: ${notMet.map(([id, entry]) => `${id} (${entry.status})`).join(', ')}`,
			details,
		}
	}
	return { ok: true, tokens, summary: `${criteria.length} criterion(s) met with evidence`, details }
}
