/**
 * Model harness. `./spec` is the M2 spec engine — every Anthropic call the api makes goes
 * through this package. `./job` is the M3 orchestrator: frozen spec → plan → task DAG →
 * parallel Claude Agent SDK workers in git worktrees → merge → lint + test, under a hard token
 * budget with a kill switch. `runJob` is driven by `apps/job` inside the Fargate container.
 */

export * from './job/index.ts'
export * from './spec/index.ts'
