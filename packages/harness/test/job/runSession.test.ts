import { runSession } from '#job/worker.ts'

// This SDK version does not always yield an `error_max_turns` result: when the CLI exits on the
// cap, `query()` throws with the result text instead (seen on Fargate 2026-08-27)
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
	query: () =>
		(async function* () {
			yield { type: 'assistant', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 5 } } }
			throw new Error('Claude Code returned an error result: Reached maximum number of turns (100)')
		})(),
}))

describe('runSession', () => {
	it('Treats the thrown "maximum number of turns" error as a capped session, not a failure', async () => {
		const outcome = await runSession({
			cwd: '/tmp',
			systemPrompt: 'x',
			prompt: 'y',
			signal: new AbortController().signal,
			onUsage: () => {},
			maxTurns: 100,
		})

		expect(outcome.ok).toBe(false)
		expect(outcome.maxTurnsReached).toBe(true)
		expect(outcome.tokens).toBeGreaterThan(0)
		expect(outcome.result).toMatch(/maximum number of turns/)
	})
})
