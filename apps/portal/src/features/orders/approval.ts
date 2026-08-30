import type { GateReport } from '@mf/models'

/** Tally of the QA gate reports shown at the approve-before-deliver gate (W7) */
export type GateSummary = {
	total: number
	passed: number
	failed: number
	/** True only when at least one gate ran and every gate is green */
	allPassed: boolean
}

/**
 * Summarises a job's gate reports for the approval panel: how many gates ran and whether they
 * are all green. `allPassed` is false for an empty set — there is nothing to approve yet.
 */
export const gateSummary = (gates: GateReport[] = []): GateSummary => {
	const passed = gates.filter(gate => gate.ok).length
	const failed = gates.length - passed
	return { total: gates.length, passed, failed, allPassed: gates.length > 0 && failed === 0 }
}
