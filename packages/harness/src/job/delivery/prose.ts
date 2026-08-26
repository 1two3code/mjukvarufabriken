import { z } from 'zod'

import { renderSpecForPlanning } from '#job/planner.ts'
import { readOnlyTools, runSession } from '#job/worker.ts'

import type { ProseWriter } from './types.ts'

const ProseOutputSchema = z.object({
	/** Two to four short paragraphs in Markdown for the "What was built" section */
	summary: z.string().min(1),
})

export const proseSystemPrompt = `You write the handover document for an application Mjukvaruhuset built for a customer. Read the repository (README, apps/, packages/) and the spec below, then describe in plain language what was built: the main flows a user has, how the pieces fit (app, api, data), and anything the customer should know before running it. Two to four short paragraphs of Markdown, no headings, no marketing. Do not change any file.`

/**
 * One read-only Agent SDK session that writes the prose of HANDOVER.md. Everything else in the
 * handover (gate table, acceptance table, limitations) is generated deterministically.
 */
export const createLiveProseWriter =
	({ model }: { model?: string } = {}): ProseWriter =>
	async ({ spec, plan, repoDir, signal, onUsage }) => {
		const session = await runSession({
			cwd: repoDir,
			systemPrompt: `${proseSystemPrompt}\n\n# The spec\n${renderSpecForPlanning(spec)}\n\n# Build plan\n${plan?.summary ?? '-'}`,
			prompt: 'Write the "What was built" section and return it as the structured output.',
			signal,
			onUsage,
			model,
			maxTurns: 40,
			tools: readOnlyTools,
			outputSchema: z.toJSONSchema(ProseOutputSchema) as Record<string, unknown>,
		})
		const parsed = ProseOutputSchema.safeParse(session.structuredOutput)
		// Prose is a nicety: a failed session falls back to the spec goal, never fails delivery
		return {
			summary: session.ok && parsed.success ? parsed.data.summary : '',
			tokens: session.tokens,
		}
	}

export const createFakeProseWriter =
	(summary = 'Fake prose about the app.', tokens = 250): ProseWriter =>
	async ({ onUsage }) => {
		onUsage({ inputTokens: tokens, outputTokens: 0 })
		return { summary, tokens }
	}
