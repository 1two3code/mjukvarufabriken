import { ResidentAuditEntrySchema } from '@mf/models'

import { dayOf } from '#/metering.ts'

import type { ResidentAuditEntry, ResidentAuditType } from '@mf/models'
import type { ObjectStore } from '#/store.ts'

export const auditKey = (day: string) => `audit/${day}.jsonl`

export type AuditLogOptions = {
	store: ObjectStore
	now?: () => number
	/** Also print every entry (JSON) — the container log is the second copy of the trail */
	log?: (entry: ResidentAuditEntry) => void
}

/**
 * Every action the resident takes, one JSON line each, in one S3 object per UTC day. S3 has
 * no append, so the day's lines are kept in memory (the object is read once on first use) and
 * the whole object is rewritten on every `append` — the log must never be behind the action
 * it describes, and an entry is a few hundred bytes. Writes to one day are serialised.
 */
export const createAuditLog = ({ store, now = Date.now, log }: AuditLogOptions) => {
	const days = new Map<string, ResidentAuditEntry[]>()
	let queue: Promise<void> = Promise.resolve()

	const load = async (day: string) => {
		const cached = days.get(day)
		if (cached) return cached
		const entries = parseAuditLines(await store.get(auditKey(day)))
		days.set(day, entries)
		return entries
	}

	const append = (type: ResidentAuditType, detail: Record<string, unknown>, taskId?: string) => {
		const entry: ResidentAuditEntry = {
			time: new Date(now()).toISOString(),
			type,
			...(taskId !== undefined && { taskId }),
			detail,
		}
		log?.(entry)
		const day = dayOf(entry.time)
		queue = queue
			.then(async () => {
				const entries = await load(day)
				entries.push(entry)
				await store.put(auditKey(day), serialiseAuditLines(entries), 'application/x-ndjson')
				// Only today (and the day that just ended) need to stay in memory
				for (const key of days.keys()) if (key < day) days.delete(key)
			})
			.catch(() => {})
		return queue
	}

	return {
		append,
		/** Entries of one day, from the store (today's in-memory tail included once flushed) */
		read: async (day: string): Promise<ResidentAuditEntry[]> => {
			await queue
			return structuredClone(await load(day))
		},
		/** Resolves once every appended entry is written */
		flush: () => queue,
	}
}

export type AuditLog = ReturnType<typeof createAuditLog>

export const serialiseAuditLines = (entries: ResidentAuditEntry[]) =>
	entries.map(entry => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : '')

/** Lines that do not parse as an entry are dropped (a truncated last line after a crash) */
export const parseAuditLines = (text: string | undefined): ResidentAuditEntry[] =>
	(text ?? '')
		.split('\n')
		.filter(line => line.trim())
		.flatMap(line => {
			try {
				const parsed = ResidentAuditEntrySchema.safeParse(JSON.parse(line))
				return parsed.success ? [parsed.data] : []
			} catch {
				return []
			}
		})
