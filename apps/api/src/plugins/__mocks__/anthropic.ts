import fp from 'fastify-plugin'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type Anthropic from '@anthropic-ai/sdk'
import type { SpecToolOutput } from '@mf/harness'

/** Canned `update_spec` tool output; override fields per test */
export const createMockSpecToolOutput = (overrides?: Partial<SpecToolOutput>): SpecToolOutput => ({
	assistantMessage: 'Got it. A couple of questions...',
	goal: 'A booking app for a small gym with 200 members',
	users: ['members'],
	features: [],
	nonGoals: [],
	nonGoalsAnswered: false,
	stackConstraints: [],
	stackConstraintsAnswered: false,
	questions: ['Which features do you need?'],
	...overrides,
})

/** Wraps a tool output in a minimal Anthropic message with a forced `update_spec` tool_use block */
export const createMockToolUseMessage = (input: unknown = createMockSpecToolOutput()) =>
	({
		id: 'msg_mock',
		type: 'message',
		role: 'assistant',
		model: 'mock',
		content: [{ type: 'tool_use', id: 'toolu_mock', name: 'update_spec', input }],
		stop_reason: 'tool_use',
		stop_sequence: null,
		stop_details: null,
		usage: { input_tokens: 10, output_tokens: 5 },
	}) as unknown as Anthropic.Message

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['anthropic'] = {
		messages: { create: vi.fn().mockResolvedValue(createMockToolUseMessage()) },
	}

	app.decorate('anthropic', mock)
}

export default fp(mockPlugin, { name: '#internal/anthropic' })
