import { z } from 'zod'
import { isSpecComplete, SpecSchema } from '@mf/models'

import { estimatePrice } from './priceEstimator.ts'

import type Anthropic from '@anthropic-ai/sdk'
import type { ChatMessage, PartialSpec, SpecDraft } from '@mf/models'

// MARK: Types

/**
 * The slice of the Anthropic SDK client the engine uses. Kept minimal so tests can pass a
 * fake with a stubbed `messages.create` — zero live calls in the test suite.
 */
export type SpecEngineClient = {
	messages: {
		create: (
			params: Anthropic.MessageCreateParamsNonStreaming,
			options?: { signal?: AbortSignal }
		) => Promise<Anthropic.Message>
	}
}

export type SpecEngineOptions = {
	client: SpecEngineClient
	/** Model id; defaults to `SPEC_MODEL` env or a Sonnet-tier model */
	model?: string
	maxTokens?: number
}

export type SpecTurn = {
	assistantMessage: string
	spec: PartialSpec
	openQuestions: string[]
	complete: boolean
	/**
	 * Every input bucket, not just `input_tokens`. A cached prefix is billed under
	 * `cache_read_input_tokens` / `cache_creation_input_tokens`, so `input_tokens` alone is the
	 * *uncached remainder* — reporting it as the turn's input under-states what was spent.
	 */
	usage: {
		inputTokens: number
		outputTokens: number
		cacheReadInputTokens: number
		cacheCreationInputTokens: number
	}
}

export type SpecEngine = {
	model: string
	nextTurn: (draft: Pick<SpecDraft, 'spec' | 'messages'>, userMessage: string) => Promise<SpecTurn>
}

// MARK: Model + prompt

export const defaultSpecModel = 'claude-sonnet-5'

export const resolveSpecModel = (override?: string) =>
	override || process.env.SPEC_MODEL || defaultSpecModel

export const specToolName = 'update_spec'

export const specSystemPrompt = `You are Mjukvaruhuset's spec engineer. Mjukvaruhuset builds small and medium web applications at a fixed price from a structured spec.

Your job: turn the conversation with the customer into a precise, buildable spec.

Rules:
- Extract and refine the spec from the whole conversation, not only the latest message. Only the most recent turns are replayed to you — the current draft spec below is the authoritative record of everything the customer has already told you. Keep all of it; refine wording, never drop content unless the customer changed their mind.
- Never invent requirements. If something is unknown, leave it out and ask.
- Ask at most 3 targeted questions per turn, only about information that is missing for a complete spec: a clear goal (at least one sentence), who the users are, each feature with concrete acceptance criteria, explicit non-goals (what is out of scope) and stack constraints (or an explicit "no constraints").
- When the customer answers "none" / "no constraints" / "nothing out of scope", record that as an empty list — it still counts as answered.
- Answer in the customer's language: Swedish if they write Swedish, otherwise English. Keep the assistant message short and friendly; the structured data goes in the tool fields.
- When the spec is complete, say so, summarise it briefly and ask the customer to review the preview and freeze the spec. Return an empty questions list.
- Acceptance criteria must be testable statements ("A logged-in user can ...", "Given ... when ... then ...").

Always respond by calling the ${specToolName} tool.`

/** Mirrors SpecSchema (minus sizeClass) plus questions + assistantMessage. Hand-written for a stable, strict schema. */
export const specToolInputSchema: Anthropic.Tool['input_schema'] = {
	type: 'object',
	properties: {
		assistantMessage: {
			type: 'string',
			description: 'The conversational reply to show the customer, in their language.',
		},
		goal: {
			type: 'string',
			description: 'What the application should achieve, one or two sentences. Empty if unknown.',
		},
		users: { type: 'array', items: { type: 'string' }, description: 'Who uses the application.' },
		features: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					description: { type: 'string' },
					acceptanceCriteria: { type: 'array', items: { type: 'string' } },
				},
				required: ['title', 'description', 'acceptanceCriteria'],
				additionalProperties: false,
			},
		},
		nonGoals: { type: 'array', items: { type: 'string' }, description: 'Explicitly out of scope.' },
		nonGoalsAnswered: {
			type: 'boolean',
			description:
				'true once the customer has explicitly said what is out of scope (even "nothing").',
		},
		stackConstraints: {
			type: 'array',
			items: { type: 'string' },
			description: 'Required technologies, hosting, integrations or compliance constraints.',
		},
		stackConstraintsAnswered: {
			type: 'boolean',
			description: 'true once the customer has explicitly stated stack constraints (even "none").',
		},
		questions: {
			type: 'array',
			items: { type: 'string' },
			description:
				'At most 3 targeted questions for missing information. Empty when the spec is complete.',
		},
	},
	required: [
		'assistantMessage',
		'goal',
		'users',
		'features',
		'nonGoals',
		'nonGoalsAnswered',
		'stackConstraints',
		'stackConstraintsAnswered',
		'questions',
	],
	additionalProperties: false,
}

export const specTool: Anthropic.Tool = {
	name: specToolName,
	description:
		'Record the refined spec extracted from the conversation, the reply to the customer and any open questions.',
	strict: true,
	input_schema: specToolInputSchema,
}

/** Validates the tool input coming back from the model */
export const SpecToolOutputSchema = SpecSchema.omit({ sizeClass: true }).extend({
	assistantMessage: z.string(),
	nonGoalsAnswered: z.boolean(),
	stackConstraintsAnswered: z.boolean(),
	questions: z.array(z.string()).max(3),
})
export type SpecToolOutput = z.infer<typeof SpecToolOutputSchema>

// MARK: Helpers

/**
 * How many stored messages (two per turn — the customer's and the engine's reply) are replayed to
 * the model. Older turns are dropped rather than resent: every turn used to spread the WHOLE
 * history, so a draft's cost per turn grew linearly and its total cost quadratically with no upper
 * bound, and a long enough chat eventually overflowed the context window and made the order's spec
 * endpoint fail permanently (audit P1-2).
 *
 * Dropping old turns is safe because the accumulated state does not live in the transcript: the
 * draft spec is replayed in full on every turn by {@link draftContext}, and the system prompt tells
 * the engine to refine that draft rather than start over. The window only bounds how much verbatim
 * conversational context the model sees.
 */
export const specHistoryWindow = 20

const ephemeral = { type: 'ephemeral' } as const

/**
 * The conversation for one turn: the tail of the stored history, then the new customer message.
 *
 * Deliberately carries NO `cache_control` breakpoint. Prompt caching is a prefix match, and a
 * sliding window is not a stable prefix: once the window is full every turn appends two messages
 * and drops two off the front, so the request's very first message block differs from the previous
 * turn's and the match fails at block 0. A breakpoint on the transcript would therefore bill the
 * whole window as a cache *write* (1.25× base input) on every turn and never read it back — about
 * 25 % MORE than simply resending it. The only content that is byte-identical AND at the same
 * position across turns is the tool schema and the system prompt, which is where the one
 * breakpoint sits (see {@link createSpecEngine}); the draft spec stays in the system array behind
 * it, where it costs the same as it always did.
 *
 * The cost defect audit P1-2 names — per-turn cost linear in the transcript, total cost quadratic,
 * and eventual permanent 500s once the context window overflowed — is closed by the window itself.
 */
export const toMessageParams = (
	messages: ChatMessage[],
	userMessage: string,
	window: number = specHistoryWindow
): Anthropic.MessageParam[] => {
	const recent = window > 0 ? messages.slice(-window) : []
	// The API requires the first message to be `user`; a window landing mid-turn would start on
	// the assistant's reply.
	const history = recent[0]?.role === 'assistant' ? recent.slice(1) : recent
	return [
		...history.map(message => ({ role: message.role, content: message.content })),
		{ role: 'user', content: userMessage },
	]
}

const draftContext = (spec: PartialSpec) =>
	`Current draft spec (JSON, may be partial — refine it, do not start over):\n${JSON.stringify(spec, null, 2)}`

/** Turns the model output into the stored partial spec: unanswered lists stay undefined */
export const toPartialSpec = (output: SpecToolOutput): PartialSpec => ({
	...(output.goal.trim() && { goal: output.goal.trim() }),
	...(output.users.length && { users: output.users }),
	...(output.features.length && { features: output.features }),
	...(output.nonGoalsAnswered && { nonGoals: output.nonGoals }),
	...(output.stackConstraintsAnswered && { stackConstraints: output.stackConstraints }),
})

const findToolInput = (message: Anthropic.Message) => {
	const block = message.content.find(
		(item): item is Anthropic.ToolUseBlock => item.type === 'tool_use' && item.name === specToolName
	)
	if (!block) {
		throw new Error(
			`Spec engine: model did not call ${specToolName} (stop_reason ${message.stop_reason})`
		)
	}
	return block.input
}

// MARK: Engine

export const createSpecEngine = ({
	client,
	model,
	maxTokens = 4096,
}: SpecEngineOptions): SpecEngine => {
	const resolvedModel = resolveSpecModel(model)

	const nextTurn: SpecEngine['nextTurn'] = async (draft, userMessage) => {
		const response = await client.messages.create({
			model: resolvedModel,
			max_tokens: maxTokens,
			// The breakpoint sits on the one block that is identical on every turn. Tools render
			// before `system`, so it caches the tool schema with it. `draftContext` follows it
			// because it changes every turn — behind the only breakpoint, it invalidates nothing.
			system: [
				{ type: 'text', text: specSystemPrompt, cache_control: ephemeral },
				{ type: 'text', text: draftContext(draft.spec) },
			],
			tools: [specTool],
			tool_choice: { type: 'tool', name: specToolName, disable_parallel_tool_use: true },
			messages: toMessageParams(draft.messages, userMessage),
		})

		const output = SpecToolOutputSchema.parse(findToolInput(response))
		const spec = toPartialSpec(output)
		const complete = isSpecComplete(spec)
		if (complete) spec.sizeClass = estimatePrice(spec).sizeClass

		return {
			assistantMessage: output.assistantMessage,
			spec,
			openQuestions: complete ? [] : output.questions,
			complete,
			usage: {
				inputTokens: response.usage.input_tokens,
				outputTokens: response.usage.output_tokens,
				cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
				cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
			},
		}
	}

	return { model: resolvedModel, nextTurn }
}
