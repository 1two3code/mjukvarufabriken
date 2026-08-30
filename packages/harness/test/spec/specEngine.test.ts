import {
	createSpecEngine,
	defaultSpecModel,
	specToolName,
	SpecToolOutputSchema,
	toPartialSpec,
} from '#spec/specEngine.ts'

import type Anthropic from '@anthropic-ai/sdk'
import type { SpecDraft } from '@mf/models'
import type { SpecEngineClient, SpecToolOutput } from '#spec/specEngine.ts'

// MARK: Fake client

const toolOutput = (overrides: Partial<SpecToolOutput> = {}): SpecToolOutput => ({
	assistantMessage: 'Tack! Några frågor...',
	goal: '',
	users: [],
	features: [],
	nonGoals: [],
	nonGoalsAnswered: false,
	stackConstraints: [],
	stackConstraintsAnswered: false,
	questions: [],
	...overrides,
})

const toolUseMessage = (input: unknown, name = specToolName): Anthropic.Message =>
	({
		id: 'msg_1',
		type: 'message',
		role: 'assistant',
		model: 'fake',
		content: [{ type: 'tool_use', id: 'toolu_1', name, input }],
		stop_reason: 'tool_use',
		stop_sequence: null,
		usage: { input_tokens: 100, output_tokens: 50 } as Anthropic.Usage,
		stop_details: null,
	}) as unknown as Anthropic.Message

const createFakeClient = (...responses: Anthropic.Message[]) => {
	const create = vi.fn<SpecEngineClient['messages']['create']>()
	responses.forEach(response => create.mockResolvedValueOnce(response))
	const client: SpecEngineClient = { messages: { create } }
	return { client, create }
}

const emptyDraft = (): Pick<SpecDraft, 'spec' | 'messages'> => ({ spec: {}, messages: [] })

// MARK: Tests

describe('createSpecEngine', () => {
	afterEach(() => vi.unstubAllEnvs())

	it('Uses the default Sonnet-tier model, overridable by SPEC_MODEL and the option', () => {
		const { client } = createFakeClient()
		expect(createSpecEngine({ client }).model).toBe(defaultSpecModel)
		vi.stubEnv('SPEC_MODEL', 'claude-opus-5')
		expect(createSpecEngine({ client }).model).toBe('claude-opus-5')
		expect(createSpecEngine({ client, model: 'claude-haiku-4-5' }).model).toBe('claude-haiku-4-5')
	})

	it('Sends the conversation with a forced tool call and returns the structured turn', async () => {
		// Arrange
		const { client, create } = createFakeClient(
			toolUseMessage(
				toolOutput({
					goal: 'En bokningsapp för ett litet gym',
					questions: ['Vilka är användarna?', 'Vilka funktioner behövs?'],
				})
			)
		)
		const engine = createSpecEngine({ client, model: 'fake-model' })

		// Act
		const turn = await engine.nextTurn(emptyDraft(), 'Jag vill ha en bokningsapp för mitt gym')

		// Assert
		const params = create.mock.calls[0]![0]
		expect(params.model).toBe('fake-model')
		expect(params.tool_choice).toEqual({
			type: 'tool',
			name: specToolName,
			disable_parallel_tool_use: true,
		})
		expect(params.tools).toEqual([expect.objectContaining({ name: specToolName, strict: true })])
		expect(params.messages).toEqual([
			{ role: 'user', content: 'Jag vill ha en bokningsapp för mitt gym' },
		])
		expect(turn).toEqual({
			assistantMessage: 'Tack! Några frågor...',
			spec: { goal: 'En bokningsapp för ett litet gym' },
			openQuestions: ['Vilka är användarna?', 'Vilka funktioner behövs?'],
			complete: false,
			usage: { inputTokens: 100, outputTokens: 50 },
		})
	})

	it('Runs the clarification loop: question → answer → complete with size class', async () => {
		// Arrange — turn 1 asks questions, turn 2 completes the spec
		const partial = toolOutput({
			goal: 'A booking app for a small gym with 200 members',
			users: ['members', 'staff'],
			features: [
				{ title: 'Book a class', description: 'Members book classes', acceptanceCriteria: [] },
			],
			questions: ['What must a booking check before it is confirmed?', 'Anything out of scope?'],
		})
		const complete = toolOutput({
			assistantMessage: 'The spec is complete — please review and freeze it.',
			goal: 'A booking app for a small gym with 200 members',
			users: ['members', 'staff'],
			features: [
				{
					title: 'Book a class',
					description: 'Members book classes',
					acceptanceCriteria: ['A member can book a class with free spots'],
				},
			],
			nonGoals: ['Payments'],
			nonGoalsAnswered: true,
			stackConstraints: [],
			stackConstraintsAnswered: true,
			questions: [],
		})
		const { client, create } = createFakeClient(toolUseMessage(partial), toolUseMessage(complete))
		const engine = createSpecEngine({ client, model: 'fake-model' })
		const draft: Pick<SpecDraft, 'spec' | 'messages'> = emptyDraft()

		// Act — turn 1
		const turn1 = await engine.nextTurn(draft, 'I want a booking app for my gym')
		draft.spec = turn1.spec
		draft.messages.push(
			{
				role: 'user',
				content: 'I want a booking app for my gym',
				createdAt: '2026-08-26T00:00:00.000Z',
			},
			{ role: 'assistant', content: turn1.assistantMessage, createdAt: '2026-08-26T00:00:01.000Z' }
		)
		// Act — turn 2
		const turn2 = await engine.nextTurn(
			draft,
			'Free spots only. No payments. No stack constraints.'
		)

		// Assert
		expect(turn1.complete).toBe(false)
		expect(turn1.openQuestions).toHaveLength(2)
		expect(turn1.spec.nonGoals).toBeUndefined()

		const secondCall = create.mock.calls[1]![0]
		expect(secondCall.messages).toHaveLength(3)
		expect(secondCall.messages[0]).toEqual({
			role: 'user',
			content: 'I want a booking app for my gym',
		})
		expect(secondCall.messages[1]?.role).toBe('assistant')
		expect(JSON.stringify(secondCall.system)).toContain('Current draft spec')

		expect(turn2.complete).toBe(true)
		expect(turn2.openQuestions).toEqual([])
		expect(turn2.spec).toEqual({
			goal: 'A booking app for a small gym with 200 members',
			users: ['members', 'staff'],
			features: complete.features,
			nonGoals: ['Payments'],
			stackConstraints: [],
			sizeClass: 'S',
		})
	})

	it('Drops the questions when the model marks the spec complete but still lists some', async () => {
		const output = toolOutput({
			goal: 'A booking app for a small gym with 200 members',
			users: ['members'],
			features: [{ title: 'Book', description: '', acceptanceCriteria: ['Works'] }],
			nonGoalsAnswered: true,
			stackConstraintsAnswered: true,
			questions: ['Leftover?'],
		})
		const { client } = createFakeClient(toolUseMessage(output))
		const turn = await createSpecEngine({ client }).nextTurn(emptyDraft(), 'hi')
		expect(turn.complete).toBe(true)
		expect(turn.openQuestions).toEqual([])
	})

	it('Throws when the model does not call the spec tool', async () => {
		const { client } = createFakeClient(toolUseMessage({}, 'other_tool'))
		await expect(createSpecEngine({ client }).nextTurn(emptyDraft(), 'hi')).rejects.toThrow(
			/did not call update_spec/
		)
	})

	it('Rejects malformed tool input', async () => {
		const { client } = createFakeClient(toolUseMessage({ goal: 42 }))
		await expect(createSpecEngine({ client }).nextTurn(emptyDraft(), 'hi')).rejects.toThrow()
	})

	it('toPartialSpec keeps only answered fields', () => {
		expect(toPartialSpec(toolOutput())).toEqual({})
		expect(
			toPartialSpec(toolOutput({ nonGoalsAnswered: true, stackConstraintsAnswered: true }))
		).toEqual({ nonGoals: [], stackConstraints: [] })
		expect(
			SpecToolOutputSchema.safeParse(toolOutput({ questions: ['1', '2', '3', '4'] })).success
		).toBe(false)
	})
})
