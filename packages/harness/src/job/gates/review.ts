import { access } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import { z } from 'zod'

import { renderSpecForPlanning } from '#job/planner.ts'

import type { ReviewFinding, Spec } from '@mf/models'

// MARK: Adversarial refute pass
//
// The review gate had failed a good build closed on findings that do not exist in the code
// (family-hub #2, 0b5efa32, 12.4M tokens — a raw-UUID claim against a name-picker UI, an
// off-by-one claim against an inclusive bound). Before a finding can fail the gate it must be
// substantiated against the ACTUAL code: the cited file has to exist, and N independent skeptics
// each try to disprove the claim by reading the cited lines. A finding a majority of skeptics can
// refute is dropped and counted as a false positive.

/** A skeptic's verdict on one finding: it could not disprove it (`upheld`) or it did (`refuted`) */
export const reviewVerdict = ['upheld', 'refuted'] as const
export type ReviewVerdict = (typeof reviewVerdict)[number]

/** How many independent skeptics vote on the findings, unless overridden */
export const defaultSkeptics = 3

const skepticsEnvVar = 'REVIEW_SKEPTICS'

/** Skeptic count: explicit override > `REVIEW_SKEPTICS` env (a non-negative int) > the default */
export const resolveSkeptics = (
	override?: number,
	env: NodeJS.ProcessEnv = process.env
): number => {
	if (override !== undefined) return Math.max(0, Math.trunc(override))
	const fromEnv = Number(env[skepticsEnvVar])
	return Number.isInteger(fromEnv) && fromEnv >= 0 ? fromEnv : defaultSkeptics
}

/** One skeptic's ruling on one finding, keyed by the finding's `<file>:<line>` id */
export const FindingVerdictSchema = z.object({
	id: z.string().min(1),
	verdict: z.enum(reviewVerdict),
	reasoning: z.string().optional(),
})
export type FindingVerdict = z.infer<typeof FindingVerdictSchema>

/** What one skeptic session returns: a verdict for every finding it was asked to disprove */
export const RefuteOutputSchema = z.object({
	verdicts: z.array(FindingVerdictSchema),
})
export type RefuteOutput = z.infer<typeof RefuteOutputSchema>

export const refuteOutputJsonSchema = z.toJSONSchema(RefuteOutputSchema) as Record<string, unknown>

/** A finding the refute pass threw out, with why and the skeptics' votes (empty when auto-dropped) */
export type RefutedFinding = {
	finding: ReviewFinding
	reason: string
	votes: ReviewVerdict[]
}

export type RefuteResult = { kept: ReviewFinding[]; refuted: RefutedFinding[] }

/**
 * A finding is a false positive when a strict majority of the skeptics refuted it. A skeptic that
 * did not rule on it (a dropped/failed session, or an id it omitted) abstains toward keeping —
 * the gate fails closed, so an unsubstantiated drop is safer than dropping a real defect.
 */
export const isFalsePositive = (votes: ReviewVerdict[], skeptics: number): boolean => {
	if (skeptics < 1) return false
	const refuted = votes.filter(vote => vote === 'refuted').length
	return refuted * 2 > skeptics
}

/**
 * Tally the skeptics' ballots into kept vs. refuted findings. Pure: `ballots[i]` is skeptic i's
 * verdicts (any subset of the findings, any order); a finding not mentioned by a skeptic is an
 * abstention. `skeptics` is the ballots that were cast — pass it explicitly so a skeptic whose
 * session failed still counts as an abstention rather than shrinking the majority.
 */
export const tallyRefutations = (
	findings: ReviewFinding[],
	ballots: FindingVerdict[][],
	skeptics: number
): RefuteResult => {
	const kept: ReviewFinding[] = []
	const refuted: RefutedFinding[] = []
	for (const finding of findings) {
		const votes = ballots
			.map(ballot => ballot.find(entry => entry.id === finding.id)?.verdict)
			.filter((verdict): verdict is ReviewVerdict => verdict !== undefined)
		if (isFalsePositive(votes, skeptics)) {
			refuted.push({ finding, reason: 'refuted by a majority of skeptics', votes })
		} else {
			kept.push(finding)
		}
	}
	return { kept, refuted }
}

/**
 * Whether the finding's cited file actually exists in the repo tree. A finding on a path that is
 * not in the repository (or one that escapes it) is a hallucinated citation — dropped before any
 * skeptic tokens are spent. Line-level verification is the skeptics' job (they read the lines).
 */
export const citationExists = async (repoDir: string, finding: ReviewFinding): Promise<boolean> => {
	const file = finding.file.trim()
	if (!file || isAbsolute(file)) return false
	const root = resolve(repoDir)
	const target = resolve(root, file)
	if (target !== root && !target.startsWith(`${root}/`)) return false
	try {
		await access(target)
		return true
	} catch {
		return false
	}
}

const renderFindingsForSkeptic = (findings: ReviewFinding[]) =>
	findings
		.map(
			finding =>
				`- [${finding.id}] ${finding.severity.toUpperCase()} ${finding.file}:${finding.line}\n` +
				`  Claim: ${finding.claim}\n` +
				`  Alleged failure: ${finding.failureScenario}`
		)
		.join('\n')

/**
 * System prompt for one adversarial skeptic. Its job is the opposite of the reviewer's: try to
 * DISPROVE each finding by reading the cited file at the cited line. The burden is on the finding —
 * uphold it only when the actual code produces the alleged failure; otherwise refute it.
 */
export const skepticSystemPrompt = (spec: Spec, range: string, findings: ReviewFinding[]) =>
	`You are an adversarial skeptic at Mjukvaruhuset. An independent reviewer flagged the findings below against this repository and the gate will fail the build closed on the high/medium ones. Reviewers hallucinate: they cite lines that do not exist, misread the code, or flag a case the code already handles. Your job is to DISPROVE each finding by reading the ACTUAL code — the build was expensive and a wrong finding is the most costly mistake here.

You are READ-ONLY: never create, edit, move or delete files, never run commands that change the working tree or git state (no git add/commit/checkout/reset, no npm install, no --write). Bash is for inspection only (git diff/log/show, grep, cat, sed -n).

For EACH finding:
1. Open the cited file at the cited line and read the surrounding code. Also read \`git diff ${range}\` for the change under review.
2. Try to construct the exact failure the claim describes from the code as written — the concrete input that produces the wrong output/crash/exposure.
3. Verdict "upheld" ONLY when you can substantiate the defect from the real code: the cited code exists and genuinely produces the alleged failure. Verdict "refuted" when you cannot — the cited lines do not exist or are unrelated, the claim misreads the code, the case is already handled (e.g. an inclusive bound, a validated input, a name picker instead of a raw id), or the failure cannot actually occur.

Be skeptical, not generous: if the code does not clearly do what the claim says, refute it. Return the structured output with one verdict per finding id below and a one-sentence reason. Do not invent findings and do not change any id.

# Findings to disprove
${renderFindingsForSkeptic(findings)}

# The spec
${renderSpecForPlanning(spec)}`

/** The user turn that starts a skeptic session */
export const skepticPrompt = (range: string) =>
	`Try to disprove each finding by reading the cited file and \`git diff ${range}\`. Return a verdict (upheld/refuted) per finding id.`
