import { AuditEntrySchema } from '#/schemas.ts'

import type { AuditEntry } from '#/schemas.ts'

/** The fields a caller supplies; `time` is stamped by the log. */
export type AuditInput = Omit<AuditEntry, 'time'>

export type AuditLogOptions = {
	/** Injectable clock for deterministic timestamps in tests. */
	now?: () => number
	/** Also emit each entry (the container log is the second copy of the trail). */
	log?: (entry: AuditEntry) => void
}

export type AuditLog = {
	record: (input: AuditInput) => AuditEntry
	/** A copy of every entry recorded so far, in order. */
	entries: () => AuditEntry[]
}

/**
 * An in-memory audit trail for a deprovision run: every resource touched, one validated entry each.
 * Kept deliberately simple — a run is bounded (a customer's tagged resources) and the caller decides
 * where to persist `entries()` (S3, the order row, stdout).
 */
export const createAuditLog = ({ now = Date.now, log }: AuditLogOptions = {}): AuditLog => {
	const list: AuditEntry[] = []
	return {
		record: input => {
			const entry = AuditEntrySchema.parse({ time: new Date(now()).toISOString(), ...input })
			list.push(entry)
			log?.(entry)
			return entry
		},
		entries: () => [...list],
	}
}
