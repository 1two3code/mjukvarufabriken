import { z } from 'zod'

/**
 * Customer/order deprovisioning lifecycle (docs/backlog/teardown-deprovisioning.md #2).
 *
 * A delivered order moves through a small, deliberate lifecycle so teardown is orderly rather
 * than ad-hoc:
 * - `active`    — the default; the delivered app runs, compute + data retained.
 * - `suspended` — reversible cost-stop: compute is torn down (ECS Express has no scale-to-zero),
 *                 cheap storage (repo/ECR/S3) is retained through a grace window. Non-payment
 *                 lands here first, never straight to deletion.
 * - `torn_down` — permanent: everything the delivery owns is deleted (the customer's repo is
 *                 theirs and is transferred, never deleted). Reached from `suspended` by an admin
 *                 or by the grace-period sweep after N days, never as a first step.
 *
 * The reversible `suspended` middle state is the whole point: deletion is last, not first, and a
 * suspended order can always be resumed back to `active` within the grace window.
 */
export const lifecycleStates = ['active', 'suspended', 'torn_down'] as const
export type LifecycleState = (typeof lifecycleStates)[number]

export const LifecycleStateSchema = z.enum(lifecycleStates)

/**
 * The three admin/scheduler actions and the transition each performs. `suspend` and `resume` are
 * inverses; `teardown` is terminal. An action is a no-op when the order is already in its target
 * state (idempotent), and `torn_down` is a dead end (`resume`/`suspend` from it are refused).
 */
export const lifecycleActions = ['suspend', 'resume', 'teardown'] as const
export type LifecycleAction = (typeof lifecycleActions)[number]

/** The @mf/org deprovision mode each lifecycle action maps to (they share the vocabulary). */
export const lifecycleActionMode: Record<LifecycleAction, 'suspend' | 'resume' | 'teardown'> = {
	suspend: 'suspend',
	resume: 'resume',
	teardown: 'teardown',
}

/** The lifecycle state an action moves an order into. */
export const lifecycleActionTarget: Record<LifecycleAction, LifecycleState> = {
	suspend: 'suspended',
	resume: 'active',
	teardown: 'torn_down',
}

/**
 * Allowed lifecycle transitions (from → to[]). A same-state action is idempotent and handled by
 * the caller; this table governs genuine moves. `torn_down` is terminal — nothing leaves it
 * (a deleted delivery cannot be resumed; a fresh order is a new delivery).
 */
export const lifecycleTransitions: Record<LifecycleState, readonly LifecycleState[]> = {
	active: ['suspended', 'torn_down'],
	suspended: ['active', 'torn_down'],
	torn_down: [],
}

export const canTransitionLifecycle = (from: LifecycleState, to: LifecycleState) =>
	from === to || lifecycleTransitions[from].includes(to)

/** True once the order's delivery is permanently gone. */
export const isLifecycleTerminal = (state: LifecycleState) => state === 'torn_down'
