import { SpecSchema } from './Spec.ts'

import type { PartialSpec, Spec } from './Spec.ts'

export const isSpec = (value: unknown): value is Spec => {
	return SpecSchema.safeParse(value).success
}

/** Minimum length of the goal statement for a spec to count as complete */
export const minGoalLength = 20

/**
 * Deterministic completeness check used by the clarification loop and the freeze step:
 * goal of at least 20 chars, at least one user, at least one feature each with at least
 * one acceptance criterion, and non-goals + stack constraints explicitly set (may be empty).
 */
export const isSpecComplete = (spec: PartialSpec | undefined): spec is Spec => {
	if (!spec) return false
	if ((spec.goal?.trim().length ?? 0) < minGoalLength) return false
	if (!spec.users?.length) return false
	if (!spec.features?.length) return false
	if (spec.features.some(feature => !feature.acceptanceCriteria.length)) return false
	if (!Array.isArray(spec.nonGoals)) return false
	if (!Array.isArray(spec.stackConstraints)) return false
	return true
}
