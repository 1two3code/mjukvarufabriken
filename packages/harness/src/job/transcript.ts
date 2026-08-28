import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

/**
 * Job-level directory (sibling of `worktrees`, under `<work>`) holding one compact JSONL transcript
 * per worker session. Derived from `repoDir` so both the worker (writing) and the debug bundle
 * (reading, on failure) locate it without threading a path through the orchestrator.
 */
export const transcriptsDir = (repoDir: string) => join(dirname(repoDir), 'transcripts')

const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max)}… (+${text.length - max} chars)` : text

/** Compact one SDK message to a debuggable record: assistant text + tool calls, or the result. */
const compact = (message: SDKMessage): Record<string, unknown> | undefined => {
	if (message.type === 'assistant') {
		const content = (message.message.content ?? []) as Array<{
			type: string
			text?: string
			name?: string
			input?: unknown
		}>
		const text = content
			.filter(part => part.type === 'text')
			.map(part => part.text ?? '')
			.join('\n')
		const tools = content
			.filter(part => part.type === 'tool_use')
			.map(part => ({ name: part.name, input: clip(JSON.stringify(part.input ?? {}), 500) }))
		if (!text && !tools.length) return undefined
		return {
			t: 'assistant',
			...(text ? { text: clip(text, 2000) } : {}),
			...(tools.length ? { tools } : {}),
		}
	}
	if (message.type === 'result') return { t: 'result', subtype: message.subtype }
	return undefined
}

export type Transcript = { onMessage: (message: SDKMessage) => void }

/**
 * A best-effort, fire-and-forget transcript sink appending compact JSONL to
 * `<transcripts>/<name>.jsonl`. Only assistant turns (text + tool calls) and the final result are
 * recorded — tool results (file dumps) are omitted to keep it small. A write error must never
 * disturb the session, so failures are swallowed; writes are synchronous so
 * lines never interleave and are on disk before the debug bundle reads them.
 */
export const openTranscript = (dir: string, name: string): Transcript => {
	const path = join(dir, `${name}.jsonl`)
	try {
		mkdirSync(dir, { recursive: true })
	} catch {
		// best-effort: a debug transcript must never disturb the build
	}
	return {
		// Synchronous so the file is complete the instant the session loop ends — the debug bundle
		// reads it right after, and an async fire-and-forget write would race that read.
		onMessage: message => {
			const record = compact(message)
			if (!record) return
			try {
				appendFileSync(path, `${JSON.stringify(record)}\n`)
			} catch {
				// swallow — best-effort, see above
			}
		},
	}
}
