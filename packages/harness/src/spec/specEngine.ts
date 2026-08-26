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
		create: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>
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
	usage: { inputTokens: number; outputTokens: number }
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
- Extract and refine the spec from the WHOLE conversation, not only the latest message. Keep everything the customer already told you; refine wording, never drop content unless the customer changed their mind.
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

const toMessageParams = (
	messages: ChatMessage[],
	userMessage: string
): Anthropic.MessageParam[] => [
	...messages.map(message => ({ role: message.role, content: message.content })),
	{ role: 'user', content: userMessage },
]

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
			system: [
				{ type: 'text', text: specSystemPrompt, cache_control: { type: 'ephemeral' } },
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
			},
		}
	}

	return { model: resolvedModel, nextTurn }
}
