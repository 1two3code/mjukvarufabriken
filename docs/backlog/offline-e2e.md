# Offline e2e harness for the build job (no tokens, seconds not minutes)

## Why
A live Fargate build takes ~50 min and ~2.5M tokens (~USD 6). Almost every bug found while
getting the first green delivery (2026-08-27, job 5e894e2a) was in the **plumbing**, not the model:
git identity, `.git/index.lock` EACCES across the two-uid sandbox, `setpriv` caps on the task
fetch, npm-install-after-merge ownership, merge-repair staging, the planner `tool_result` 400,
the SDK `error_max_turns` thrown-not-yielded, the empty-JSON token claim, the CLI `$schema`
rejection, the licence gate's own-workspace + ELSPROBLEMS false-positives. None of those need
Anthropic — they need the real git/fs/gate code run against a fake model. Build that harness so it
becomes the default iteration loop; the live run stays a pre-release check only.

## The two seams (already injectable — this is not a refactor)
1. **Planner** — `createPlanner({ client })` in `packages/harness/src/job/planner.ts` takes a
   `SpecEngineClient` (Anthropic-shaped `messages.create`). `packages/harness/test/job/planner.test.ts`
   already builds a fake one (`createFakeClient`, `toolUseMessage`). Reuse that shape.
2. **Workers + model gates** — `worker.ts` imports `query` from `@anthropic-ai/claude-agent-sdk`.
   `packages/harness/test/job/runTask.test.ts` already `vi.mock`s it with a queued stream of
   result messages whose sessions write real files into the worktree (`fakeSessions`). Reuse that.
   The M4 gate sessions (acceptance-tests, review, acceptance-check) go through the same `query()`
   /`runSession` seam and can be driven by the same canned stream (they call the `submit_*`
   structured-output tools — return matching `structured_output`).

Everything else runs FOR REAL: `createLivePorts` → real `runTask`/`mergeTask`/`verify`, real
`createWorktree`/`fetchTaskBranch`/`commitLeftovers`, the real deterministic gates (verify =
lint+test, licence), the real budget/kill, and delivery through `createFakeDeliveryClients`
(in-memory artifact store).

## What to build
`packages/harness/test/job/e2e.offline.test.ts` (a Vitest test, part of `@mf/harness`):

- Seed a temp repo from `templates/web` the same way `apps/job/src/repo.ts` `seedRepo` does
  (copy with `verbatimSymlinks: true`, `git init -b main`, first commit; node_modules comes with
  the copy so real `npm run lint`/`npm test`/`vitest` work — no network). Use `WORKER_UID` unset
  so it runs as the current user (the uid split is exercised separately in `exec.test.ts`; here we
  cover the git/gate/merge/delivery plumbing end to end).
- A fake `SpecEngineClient` returning a canned 3-task plan (foundation + two parallel) referencing
  real acceptance-criteria ids from a small canned `Spec`.
- `vi.mock('@anthropic-ai/claude-agent-sdk')` whose `query()` returns, per session, a stream that
  makes small REAL edits to the worktree that keep lint+test green (e.g. touch a file, add a
  trivially-passing test), then a `success` result — plus, for the gate sessions, the right
  `structured_output` (a `ReviewOutput` with no findings, an `AcceptanceReport` marking each
  criterion `met`, and the acceptance-tests session writing one passing `*.test.tsx` per
  criterion). Key by the session's system prompt / prompt so the harness dispatches the right
  canned response to worker vs each gate.
- Run the real `runJob(job, { ports: createLivePorts({ client, delivery: createFakeDeliveryClients() }) })`
  with a small budget and `maxWorkers` 2, `delivery` target set.
- Assert the full event sequence: `planned` → `task_started`/`task_finished`/`merge` per task →
  `gate` (verify, acceptance-tests, review, licence, acceptance-check) all ok → `delivery` steps
  → outcome `delivered` with a `deliverable` (repo url, bundle key). Assert the fake artifact store
  received `repo.zip` + the docs + `gates.json`/`acceptance.json`. Zero real network/model calls.
- Add negative cases that would have caught tonight's bugs, each in seconds: a worker session that
  makes NO commits → task fails "worker produced no commits"; a merge conflict → repair session →
  staged + merged; a worker that leaves lint red → gate fails closed; the planner's first plan
  invalid → retry path (assert the retry sends a `tool_result`, not plain text); a gate session
  that returns a `ReviewOutput` with an unwaived high finding → review gate fails closed.
- Root script `npm run e2e` (or `harness:e2e`) = `vitest run packages/harness/test/job/e2e.offline.test.ts`.
  Keep it in the normal `npm test` run too (it must be fast: target < ~60 s total).

## Also (small, high-value)
- **Debug bundle on failure**: in `apps/job` (or the delivery path), when a job FAILS after the
  build, upload the built repo (`git archive` of `main` + the gate/acceptance reports) to
  `deliverables/<jobId>/debug/` so a real build can be pulled once and its gates re-run locally
  with `gates-demo --repo <dir>` forever — no rebuild. Gate this behind the same real-S3-in-dry-run
  logic just added to `createLiveDeliveryClients` (the artifacts store is real when a bucket is set).
  Add a unit test with the fake store.
- Note in `docs/EFFICIENCY.md` (or a new `docs/TESTING.md`): offline `npm run e2e` is the default
  loop; the live Fargate run is a pre-release smoke test only; a future `--record`/replay cassette
  over `SpecEngineClient` + `query()` can seed offline runs from one real run (design later, not now).

## Verify
`npm run lint`, `npm test` (the new e2e included and green), `npm run build`. Commit in
conventional commits. Do NOT deploy, do NOT touch `templates/web`, stay inside `packages/harness`
(+ the small `apps/job` debug-bundle piece and the docs). Report: what the e2e covers, its runtime,
which of tonight's bug classes each negative case pins, and anything left out.
