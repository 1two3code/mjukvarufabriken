#!/usr/bin/env node
// Computes what this project's Claude Code sessions cost, from the local transcripts.
//
// Claude Code writes one JSONL record per message under ~/.claude/projects/<slug>/, each
// carrying the model and a full `usage` block (input, output, cache read, and cache creation
// split by 5m/1h TTL). That is everything needed to price a session — `/cost` is a client-side
// command whose output the model never sees, so this is how a session records its own spend.
//
// The figure is LIST-PRICE API-EQUIVALENT: what these tokens would cost on the Anthropic API.
// On a Claude Code subscription you are not billed per token, so treat this as the value of the
// compute consumed, not an invoice. Compare against `/cost` once to see how they relate.
//
//   node scripts/session-cost.mjs                 # this project, per day + per model
//   node scripts/session-cost.mjs --since=2026-09-01
//   node scripts/session-cost.mjs --all           # every project under ~/.claude/projects
//   node scripts/session-cost.mjs --ledger        # one TOKENS.md-shaped row per day
import { readdirSync, statSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * USD per million tokens, [input, output, cacheRead?]. Cache read defaults to 0.1x input
 * (Fable 5.1 bills cache reads at a flat 0.25 USD/MTok), write 5m = 1.25x, 1h = 2x.
 */
const PRICES = {
	'claude-fable-5-1': [10, 50, 0.25],
	'claude-fable-5': [10, 50],
	'claude-mythos-5': [10, 50],
	'claude-opus-5': [5, 25],
	'claude-opus-4-8': [5, 25],
	'claude-opus-4-7': [5, 25],
	'claude-opus-4-6': [5, 25],
	'claude-sonnet-5': [2, 10],
	'claude-sonnet-4-6': [3, 15],
	'claude-haiku-4-5': [1, 5],
	'claude-haiku-4-5-20251001': [1, 5],
}

const costOf = (model, u) => {
	const price = PRICES[model]
	if (!price) return undefined
	const [input, output, cacheRead = input * 0.1] = price
	const created = u.cache_creation ?? {}
	const fiveMin = created.ephemeral_5m_input_tokens ?? u.cache_creation_input_tokens ?? 0
	const oneHour = created.ephemeral_1h_input_tokens ?? 0
	return (
		((u.input_tokens ?? 0) * input +
			(u.output_tokens ?? 0) * output +
			(u.cache_read_input_tokens ?? 0) * cacheRead +
			fiveMin * input * 1.25 +
			oneHour * input * 2) /
		1_000_000
	)
}

const walk = dir => {
	const out = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) out.push(...walk(path))
		else if (entry.name.endsWith('.jsonl')) out.push(path)
	}
	return out
}

const main = async () => {
	const args = process.argv.slice(2)
	const since = args.find(a => a.startsWith('--since='))?.split('=')[1]
	const root = join(homedir(), '.claude', 'projects')
	const dirs = args.includes('--all')
		? [root]
		: readdirSync(root)
				.filter(name => name.includes('mjukvarufabriken'))
				.map(name => join(root, name))

	const seen = new Set()
	const byDay = new Map()
	const byModel = new Map()
	const unpriced = new Map()
	let files = 0

	for (const dir of dirs) {
		let paths
		try {
			paths = statSync(dir).isDirectory() ? walk(dir) : []
		} catch {
			continue
		}
		for (const path of paths) {
			files++
			const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
			for await (const line of lines) {
				if (!line.includes('"usage"')) continue
				let record
				try {
					record = JSON.parse(line)
				} catch {
					continue
				}
				const message = record.message
				const usage = message?.usage
				const model = message?.model
				if (!usage || !model) continue
				// The same message can appear in more than one transcript (resume, compaction)
				const key = message.id ?? record.uuid
				if (key) {
					if (seen.has(key)) continue
					seen.add(key)
				}
				const day = (record.timestamp ?? '').slice(0, 10)
				if (since && day && day < since) continue
				const cost = costOf(model, usage)
				if (cost === undefined) {
					unpriced.set(model, (unpriced.get(model) ?? 0) + 1)
					continue
				}
				byDay.set(day, (byDay.get(day) ?? 0) + cost)
				byModel.set(model, (byModel.get(model) ?? 0) + cost)
			}
		}
	}

	const total = [...byDay.values()].reduce((sum, n) => sum + n, 0)
	const days = [...byDay.keys()].sort()

	if (args.includes('--ledger')) {
		for (const day of days) console.log(`| ${day} | | | | ~$${byDay.get(day).toFixed(0)} |`)
		return
	}

	console.log(`${files} transcript file(s), ${seen.size} priced messages\n`)
	console.log('DAY           USD')
	for (const day of days) console.log(`${(day || '(no ts)').padEnd(12)} ${byDay.get(day).toFixed(2).padStart(9)}`)
	console.log(`${'TOTAL'.padEnd(12)} ${total.toFixed(2).padStart(9)}\n`)
	console.log('MODEL                        USD')
	for (const [model, cost] of [...byModel].sort((a, b) => b[1] - a[1])) {
		console.log(`${model.padEnd(28)} ${cost.toFixed(2).padStart(8)}`)
	}
	if (unpriced.size) console.log('\nunpriced (excluded):', Object.fromEntries(unpriced))
	console.log('\nList-price API equivalent — not a subscription invoice. See the header comment.')
}

await main()
