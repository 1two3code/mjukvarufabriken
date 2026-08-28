import { z } from 'zod'

import { PartialSpecSchema } from './Spec.ts'

/**
 * The resident LLM's structured *iteration brief* for one customer org and project (M11,
 * docs/backlog/environments.md). While the resident works with the customer in the live dev
 * loop it notices and captures the questions that go BEYOND frontend — data model, integrations,
 * auth/roles, business rules, infra, scale — and writes down the answers. The brief accumulates
 * across iterations and is exported as the seed for the next full factory build (the
 * `@mf/harness` spec engine / planner consume `SpecDraft`-shaped input), turning ad-hoc requests
 * into captured requirements the factory can build against.
 *
 * This is the DATA + API foundation only; wiring the live resident-LLM into it is later M11.
 */

// MARK: Enums
/**
 * The kind of an entry the brief accumulates:
 * - `question` — an open question the resident raised (unanswered until an `answer` refers to it)
 * - `answer` — the customer's / operator's answer to a `question` (`answersEntryId`)
 * - `decision` — a locked decision the next build must honour
 * - `context` — captured background the factory should know
 */
export const iterationBriefEntryKind = ['question', 'answer', 'decision', 'context'] as const
export type IterationBriefEntryKind = (typeof iterationBriefEntryKind)[number]

/** The topic an entry is about — deliberately the areas that go beyond "just frontend" */
export const iterationBriefTopic = [
	'data-model',
	'integrations',
	'auth',
	'business-rules',
	'infra',
	'scale',
	'other',
] as const
export type IterationBriefTopic = (typeof iterationBriefTopic)[number]

/** Topics that are genuine stack constraints the factory must honour, seeded into the spec */
export const iterationBriefStackTopics: readonly IterationBriefTopic[] = [
	'data-model',
	'integrations',
	'auth',
	'infra',
	'scale',
]

/** Who produced an entry: the resident LLM, the customer, or an operator at the factory */
export const iterationBriefAuthor = ['resident', 'customer', 'operator'] as const
export type IterationBriefAuthor = (typeof iterationBriefAuthor)[number]

// MARK: Entry
export const IterationBriefEntrySchema = z.object({
	id: z.string().min(1),
	kind: z.enum(iterationBriefEntryKind),
	topic: z.enum(iterationBriefTopic),
	/** The question / answer / decision / context text */
	body: z.string().min(1),
	/** For an `answer`, the id of the `question` entry it resolves */
	answersEntryId: z.string().min(1).optional(),
	author: z.enum(iterationBriefAuthor),
	createdAt: z.iso.datetime(),
})
export type IterationBriefEntry = z.infer<typeof IterationBriefEntrySchema>

// MARK: Brief
/** One iteration brief, keyed by org and project, accumulating entries in append order */
export const IterationBriefSchema = z.object({
	orgId: z.string().min(1),
	/** The project (delivered app) the brief accumulates for — the order id in practice */
	projectId: z.string().min(1),
	/** Human title of the project/app, set on first append when provided */
	title: z.string().optional(),
	entries: z.array(IterationBriefEntrySchema),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
})
export type IterationBrief = z.infer<typeof IterationBriefSchema>

// MARK: Append (API input)
/** A new entry appended via `POST /bff/projects/:projectId/brief/entries`; the api mints id + time */
export const NewIterationBriefEntrySchema = z
	.object({
		kind: z.enum(iterationBriefEntryKind),
		topic: z.enum(iterationBriefTopic).default('other'),
		body: z.string().min(1).max(20_000),
		answersEntryId: z.string().min(1).optional(),
		/** Defaults to `resident` — the resident LLM is the usual author */
		author: z.enum(iterationBriefAuthor).default('resident'),
	})
	.strict()
	.refine(input => input.kind === 'answer' || input.answersEntryId === undefined, {
		message: 'answersEntryId is only valid on an answer entry',
		path: ['answersEntryId'],
	})
export type NewIterationBriefEntry = z.infer<typeof NewIterationBriefEntrySchema>

export const IterationBriefMutationSchemas = { AppendEntry: NewIterationBriefEntrySchema }

// MARK: Spec-engine export
/**
 * The brief exported as an input the spec engine can seed the next draft from. It mirrors the
 * fields `SpecDraft` carries so the planner consumes it without a new shape: a `PartialSpec`
 * seed (stack constraints the factory must honour), the still-open questions the spec engine
 * should resolve, the locked decisions, and rendered context lines for the planning prompt.
 */
export const IterationBriefSpecSeedSchema = z.object({
	orgId: z.string().min(1),
	projectId: z.string().min(1),
	title: z.string().optional(),
	/** Partial spec seed (references `SpecDraft.spec`) — stack constraints derived from decisions */
	spec: PartialSpecSchema,
	/** Unanswered questions (references `SpecDraft.openQuestions`) */
	openQuestions: z.array(z.string()),
	/** Locked decisions the next build must honour */
	decisions: z.array(z.string()),
	/** Captured context — context notes plus answered question/answer pairs, for the prompt */
	context: z.array(z.string()),
})
export type IterationBriefSpecSeed = z.infer<typeof IterationBriefSpecSeedSchema>

// MARK: Derivations (pure, testable)
/** Ids of `question` entries no `answer` entry refers to */
export const unansweredQuestionIds = (brief: Pick<IterationBrief, 'entries'>): Set<string> => {
	const answered = new Set<string>()
	for (const entry of brief.entries) {
		if (entry.kind === 'answer' && entry.answersEntryId) answered.add(entry.answersEntryId)
	}
	return new Set(
		brief.entries
			.filter(entry => entry.kind === 'question' && !answered.has(entry.id))
			.map(entry => entry.id)
	)
}

/**
 * Projects the brief into the spec-engine seed. Pure so both the api and, later, the planner can
 * derive the same input from a stored brief.
 */
export const toIterationBriefSpecSeed = (brief: IterationBrief): IterationBriefSpecSeed => {
	const unanswered = unansweredQuestionIds(brief)
	const decisions = brief.entries.filter(entry => entry.kind === 'decision')
	const answersByQuestion = new Map<string, string[]>()
	for (const entry of brief.entries) {
		if (entry.kind === 'answer' && entry.answersEntryId) {
			answersByQuestion.set(entry.answersEntryId, [
				...(answersByQuestion.get(entry.answersEntryId) ?? []),
				entry.body,
			])
		}
	}

	const context: string[] = []
	for (const entry of brief.entries) {
		if (entry.kind === 'context') context.push(entry.body)
		if (entry.kind === 'question' && !unanswered.has(entry.id)) {
			for (const answer of answersByQuestion.get(entry.id) ?? []) {
				context.push(`Q: ${entry.body} — A: ${answer}`)
			}
		}
	}

	const stackConstraints = decisions
		.filter(entry => iterationBriefStackTopics.includes(entry.topic))
		.map(entry => entry.body)

	return {
		orgId: brief.orgId,
		projectId: brief.projectId,
		title: brief.title,
		spec: stackConstraints.length ? { stackConstraints } : {},
		openQuestions: brief.entries
			.filter(entry => entry.kind === 'question' && unanswered.has(entry.id))
			.map(entry => entry.body),
		decisions: decisions.map(entry => entry.body),
		context,
	}
}
