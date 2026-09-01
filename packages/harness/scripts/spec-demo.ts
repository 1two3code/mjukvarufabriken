/**
 * Scripted 3-turn spec conversation against the REAL spec engine (live API, opt-in).
 * Run from the repo root: `npm run spec:demo` (loads root .env if present).
 * Exits 0 with a "skipped" message when ANTHROPIC_API_KEY is not set.
 */
import Anthropic from '@anthropic-ai/sdk'

import { createSpecEngine, estimatePrice } from '#spec/index.ts'

import type { SpecDraft } from '@mf/models'

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
	console.log('skipped: ANTHROPIC_API_KEY not set')
	process.exit(0)
}

const turns = [
	'Hej! Jag driver ett litet gym med ca 200 medlemmar och vill ha en enkel webbapp där medlemmar kan boka gruppklasser.',
	'Användare är medlemmar och vår personal. Funktioner: se schema för veckan, boka en plats på en klass (max antal platser), avboka senast 2 timmar innan. Personal ska kunna lägga upp och ställa in klasser.',
	'Inget utanför det — ingen betalning, ingen app i butikerna. Inga tekniska krav, ni väljer stack. Inloggning med e-postlänk räcker.',
]

const engine = createSpecEngine({ client: new Anthropic({ apiKey }) })
const draft: Pick<SpecDraft, 'spec' | 'messages'> = { spec: {}, messages: [] }
let totalIn = 0
let totalOut = 0
// Counted separately: `input_tokens` is only the uncached remainder, so summing it alone would
// under-report the turn's real input by whatever the cached system prefix covers.
let totalCacheRead = 0
let totalCacheWrite = 0

console.log(`model: ${engine.model}\n`)
for (const [index, userMessage] of turns.entries()) {
	console.log(`--- turn ${index + 1} / user:\n${userMessage}\n`)
	const turn = await engine.nextTurn(draft, userMessage)
	totalIn += turn.usage.inputTokens
	totalOut += turn.usage.outputTokens
	totalCacheRead += turn.usage.cacheReadInputTokens
	totalCacheWrite += turn.usage.cacheCreationInputTokens
	const now = new Date().toISOString()
	draft.messages.push(
		{ role: 'user', content: userMessage, createdAt: now },
		{ role: 'assistant', content: turn.assistantMessage, createdAt: now }
	)
	draft.spec = turn.spec
	console.log(`--- turn ${index + 1} / assistant:\n${turn.assistantMessage}`)
	if (turn.openQuestions.length) {
		console.log(`open questions: ${JSON.stringify(turn.openQuestions)}`)
	}
	console.log(`complete: ${turn.complete}\n`)
}

console.log('=== resulting spec')
console.log(JSON.stringify(draft.spec, null, 2))
const price = estimatePrice(draft.spec)
console.log(`\n=== size ${price.sizeClass} → ${price.priceSek.toLocaleString('sv-SE')} SEK ex moms`)
console.log(
	`tokens: ${totalIn} in (uncached) / ${totalCacheRead} cache read / ${totalCacheWrite} cache write / ${totalOut} out`
)
