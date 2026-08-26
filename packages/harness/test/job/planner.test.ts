import {
	createPlanner,
	defaultPlanModel,
	parsePlan,
	planToolName,
	renderSpecForPlanning,
} from '#job/planner.ts'

import type Anthropic from '@anthropic-ai/sdk'
import type { Plan, Spec } from '@mf/models'
import type { SpecEngineClient } from '#spec/specEngine.ts'

const spec: Spec = {
	goal: 'A one-page site',
	users: ['visitors'],
	features: [
		{ title: 'Landing', description: 'Hero + footer', acceptanceCriteria: ['Renders a hero'] },
		{
			title: 'Contact form',
			description: 'mailto',
			acceptanceCriteria: ['Validates email', 'Opens mailto'],
		},
	],
	nonGoals: ['No backend'],
	stackConstraints: [],
	sizeClass: 'S',
}

const validPlan: Plan = {
	summary: 'Two tasks',
	tasks: [
		{
			id: 'landing',
			title: 'Landing',
			description: 'Build it',
			dependsOn: [],
			areas: ['apps/app'],
			acceptanceCriteriaIds: ['f0.c0'],
		},
		{
			id: 'contact',
			title: 'Contact',
			description: 'Build it',
			dependsOn: ['landing'],
			areas: ['apps/app'],
			acceptanceCriteriaIds: ['f1.c0', 'f1.c1'],
		},
	],
}

const toolUseMessage = (input: unknown, name = planToolName): Anthropic.Message =>
	({
		id: 'msg_1',
		type: 'message',
		role: 'assistant',
		model: 'fake',
		content: [{ type: 'tool_use', id: 'toolu_1', name, input }],
		stop_reason: 'tool_use',
		stop_sequence: null,
		stop_details: null,
		usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50 },
	}) as unknown as Anthropic.Message

const createFakeClient = (...responses: Anthropic.Message[]) => {
	const create = vi.fn<SpecEngineClient['messages']['create']>()
	responses.forEach(response => create.mockResolvedValueOnce(response))
	return { client: { messages: { create } } satisfies SpecEngineClient, create }
}

describe('planner', () => {
	afterEach(() => vi.unstubAllEnvs())

	it('Renders criterion ids the planner must reference', () => {
		const text = renderSpecForPlanning(spec)
		expect(text).toContain('[f0.c0] Renders a hero')
		expect(text).toContain('[f1.c1] Opens mailto')
		expect(text).toContain('Size class: S')
	})

	it('Uses the default model, overridable by PLAN_MODEL and the option', () => {
		const { client } = createFakeClient()
		expect(createPlanner({ client }).model).toBe(defaultPlanModel)
		vi.stubEnv('PLAN_MODEL', 'claude-opus-5')
		expect(createPlanner({ client }).model).toBe('claude-opus-5')
		expect(createPlanner({ client, model: 'claude-haiku-4-5' }).model).toBe('claude-haiku-4-5')
	})

	it('Makes one forced strict tool call and reports usage', async () => {
		const { client, create } = createFakeClient(toolUseMessage(validPlan))
		const onUsage = vi.fn()

		const plan = await createPlanner({ client }).plan({ spec, onUsage })

		expect(plan).toEqual(validPlan)
		expect(create).toHaveBeenCalledTimes(1)
		const params = create.mock.calls[0]![0]
		expect(params.tool_choice).toEqual({
			type: 'tool',
			name: planToolName,
			disable_parallel_tool_use: true,
		})
		expect(params.tools?.[0]).toMatchObject({ name: planToolName, strict: true })
		expect(onUsage).toHaveBeenCalledWith({
			inputTokens: 1000,
			outputTokens: 200,
			cacheReadInputTokens: 50,
			cacheCreationInputTokens: 0,
		})
	})

	it('Retries once with the validation error when the plan is not a DAG', async () => {
		const cyclic = {
			...validPlan,
			tasks: validPlan.tasks.map(task => ({ ...task, dependsOn: ['landing', 'contact'] })),
		}
		const { client, create } = createFakeClient(toolUseMessage(cyclic), toolUseMessage(validPlan))

		const plan = await createPlanner({ client }).plan({ spec })

		expect(plan).toEqual(validPlan)
		expect(create).toHaveBeenCalledTimes(2)
		const retryMessages = create.mock.calls[1]![0].messages
		expect(retryMessages).toHaveLength(3)
		expect(String(retryMessages[2]!.content)).toMatch(/rejected: .*cycle/)
	})

	it('Fails when the corrected plan is still invalid', async () => {
		const invalid = { summary: 'x', tasks: [] }
		const { client } = createFakeClient(toolUseMessage(invalid), toolUseMessage(invalid))

		await expect(createPlanner({ client }).plan({ spec })).rejects.toThrow()
	})

	it('Fails when the model does not call the tool', async () => {
		const { client } = createFakeClient(toolUseMessage(validPlan, 'other'), toolUseMessage({}))

		await expect(createPlanner({ client }).plan({ spec })).rejects.toThrow()
	})

	it('parsePlan rejects unsafe task ids', () => {
		const bad = { ...validPlan, tasks: [{ ...validPlan.tasks[0]!, id: 'Bad Id!' }] }
		expect(() => parsePlan(bad)).toThrow()
	})
})
