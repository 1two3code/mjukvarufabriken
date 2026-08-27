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

	// The thrown cap path never delivers the `result` message, so the authoritative `modelUsage`
	// (which the yielded cap path reconciles against for subagents/compaction) is unavailable. It
	// must still top the streamed total up by the conservative uplift, not leave it under-charged.
	it('Applies the conservative auxiliary top-up on the thrown cap path', async () => {
		const deltas: number[] = []
		const outcome = await runSession({
			cwd: '/tmp',
			systemPrompt: 'x',
			prompt: 'y',
			signal: new AbortController().signal,
			onUsage: usage => deltas.push(usage.inputTokens + usage.outputTokens),
			maxTurns: 100,
		})

		// Streamed 15 (10 + 5), uplifted by 10 % → ceil(16.5) = 17, so a 2-token top-up follows.
		expect(outcome.tokens).toBe(17)
		expect(deltas).toEqual([15, 2])
	})
})
