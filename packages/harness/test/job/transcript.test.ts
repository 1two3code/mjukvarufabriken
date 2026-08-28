import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { openTranscript, transcriptsDir } from '../../src/job/transcript.ts'

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

const assistant = (content: unknown): SDKMessage =>
	({ type: 'assistant', message: { content } }) as unknown as SDKMessage
const result = (subtype: string): SDKMessage =>
	({ type: 'result', subtype }) as unknown as SDKMessage

describe('transcript', () => {
	it('derives the transcripts dir as a sibling of the repo', () => {
		expect(transcriptsDir('/work/repo')).toBe('/work/transcripts')
	})

	it('records assistant text + tool calls and the result, skipping other messages', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'tx-'))
		try {
			const t = openTranscript(dir, 'foundation.worker')
			t.onMessage(
				assistant([
					{ type: 'text', text: 'planning' },
					{ type: 'tool_use', name: 'Edit', input: { file: 'a.ts' } },
				])
			)
			t.onMessage({ type: 'system' } as unknown as SDKMessage)
			t.onMessage(result('error_max_turns'))
			await t.flush()
			const lines = (await readFile(join(dir, 'foundation.worker.jsonl'), 'utf8'))
				.trim()
				.split('\n')
				.map(line => JSON.parse(line) as Record<string, unknown>)
			expect(lines).toHaveLength(2)
			expect(lines[0]).toMatchObject({ t: 'assistant', text: 'planning', tools: [{ name: 'Edit' }] })
			expect(lines[1]).toEqual({ t: 'result', subtype: 'error_max_turns' })
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

})
