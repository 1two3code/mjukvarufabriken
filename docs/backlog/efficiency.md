# Stream: efficiency — cut worker token burn (analysis + low-risk changes)

Areas: `packages/harness` (`src/job/worker.ts`, prompts, `verifyRepo`), `docs/EFFICIENCY.md`.
No live model calls in this stream; use the recorded numbers below and fakes.

## Context
Measured 2026-08-26 (S demo spec, claude-sonnet-5 workers, budget-tokens weight cache reads at
10 %): local job #5 — task 1 42 turns / 190k / USD 0.50, task 2 119 turns / 1.25M / USD 3.19;
Fargate job 266a218a — 4 tasks, 86 + ~120 + ~60 + ~80 turns, 2.54M budget-tokens, ≈ USD 6.5,
44 min. Every worker turn re-reads a large context; workers run the FULL repo `npm run lint` and
`npm test` repeatedly (the template monorepo has several workspaces), and the system prompt
tells them to.

## Deliverables
1. `docs/EFFICIENCY.md`: where the turns go, from the Agent SDK message stream shape (tool calls
   per turn, lint/test invocations) — reason from the code and the numbers above; list the
   levers with expected savings and risk.
2. Low-risk changes, each behind a constant or option with a test:
   - scope the worker's gate to the workspaces the task touches (`areas` from the plan →
     `npm run lint -w <ws>` / `vitest --project <ws>`), full-repo gate stays at merge/verify;
   - tell the worker to run lint/test at most twice (once after implementing, once after fixes)
     and to prefer `tsgo --noemit` over the full lint while iterating;
   - trim `repoConventions`/system prompt to what a task needs; move the long template CLAUDE.md
     into a "read if needed" pointer;
   - cap `maxTurns` per task by size (S 60 / M 100 / L 150) with the repair session as the
     safety valve; make the cap visible in the task_failed reason;
   - enable prompt caching hints where the SDK supports them (check the `claude-api` skill).
3. Do NOT change budget weights or pricing; do not touch gates (m4-gates owns them).

## Verification
- `npm run lint`, `npm test`. Numbers stay estimates until the main session runs the next live
  job; say so in PLAN.md (M10 dogfood note) and the report.
