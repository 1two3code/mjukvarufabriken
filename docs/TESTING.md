# Testing the build job

## The offline e2e is the default iteration loop

```sh
npm run e2e      # vitest run packages/harness/test/job/e2e.offline.test.ts
```

`packages/harness/test/job/e2e.offline.test.ts` runs the **whole** build-job pipeline —
plan → DAG build → merges → the five QA gates → delivery — against the golden template
(`templates/web`), with **no Anthropic calls and no network**, in ~45 s.

Only two seams are faked; everything else is the real code path:

1. **The planner** — `createPlanner({ client })` takes an Anthropic-shaped `SpecEngineClient`.
   The test passes a fake `messages.create` that returns a canned `submit_plan` tool call.
2. **The workers + the model gates** — `worker.ts`/the gate sessions reach the model only through
   `runSession`, which imports `query` from `@anthropic-ai/claude-agent-sdk`. The test `vi.mock`s
   `query` with a stream that makes small **real** edits to the worktree (keeping lint + test green)
   and returns the matching structured output for each gate (`ReviewOutput`, `AcceptanceReport`).
   Sessions are dispatched by their system prompt, so one handler drives worker vs. each gate.

Real, for every run: `createLivePorts` → real `runTask`/`mergeTask`/`verify`, real
`createWorktree`/`fetchTaskBranch`/`commitLeftovers`, the real deterministic gates (verify =
lint + test, licence), the real budget/kill wiring, and delivery through
`createFakeDeliveryClients` (an in-memory GitHub/ECS Express/S3).

Almost every bug found on the first green live delivery (2026-08-27, job `5e894e2a`) was in this
plumbing — git identity, `.git/index.lock` across the two uids, `setpriv` caps, npm-install after
merge, merge-repair staging, the planner `tool_result` 400, the SDK `error_max_turns`, the empty
JSON token claim, the CLI `$schema` rejection, the licence gate false positives — none of which
need Anthropic. The e2e's negative cases pin those classes so a regression fails in seconds:

| Negative case | Bug class it pins |
|---|---|
| worker makes no commits → task fails | an empty branch must fail, never merge |
| gate stays lint-red → task fails closed | a red gate never delivers broken code |
| merge conflict → repair session → staged + merged | merge-repair staging (“still conflicted” after on-disk resolution) |
| first plan invalid → retry sends a `tool_result` | the planner `tool_result` 400 (plain-text correction after a tool_use) |
| review returns an unwaived high finding → gate fails closed | the independent review gate failing open |
| job killed mid-build → ends `killed`, no delivery | the kill poll (`hooks.isKilled`) aborts every session |
| tiny `maxTokens` → first breach aborts `failed` (`budget exceeded`) | the shared budget aborting on the first over-limit usage |
| `WORKER_UID` set → a session is wrapped in `setpriv --reuid …` | the two-uid sandbox spawner (command wrapping asserted, no real uid switch) |
| a gate fails closed → `uploadDebugBundle` writes `debug/repo.zip` + reports | the failed-build archive apps/job uploads for offline gate replay |
| dry-run ECS Express deploy → a `deployUrl` and repo + bundle still the contract | delivery never blocked by a faked deploy |

The e2e is part of the normal `npm test` run (it lives in the `@mf/harness` vitest project) and is
kept fast on purpose (< ~60 s): `node_modules` is hard-linked into the seeded repo, and the tasks
are scoped to `apps/*` workspaces so their gates stay workspace-scoped.

## The live Fargate run is a pre-release smoke test only

A live build takes ~50 min and ~2.5M tokens (~USD 6). Run it before a release to exercise the real
Agent SDK, the real GitHub/ECS Express/S3 and the sandbox uid split (`WORKER_UID`) — not as the
day-to-day loop. When a live build fails after the build phase, the job uploads a debug bundle
(`git archive` of `main` + `gates.json`/`acceptance.json`) to `deliverables/<jobId>/debug/`, so the
build can be pulled **once** and its gates re-run locally forever with `npm run gates:demo -- --repo <dir>`
— no rebuild.

## Record/replay cassettes — seed an offline run from one real build

The offline e2e's handler is hand-written. A **cassette**
(`packages/harness/src/testing/cassette.ts`, exported as `@mf/harness/testing`) captures one real
run instead, over the same two seams — the planner's `SpecEngineClient` and the Agent SDK `query()`
each session streams from (reached through the `setSessionQuery` seam in `worker.ts`) — and replays
it through the **real** `runJob` with zero tokens and zero network.

```sh
npm run e2e:replay                 # replay the committed fixture (test/fixtures/cassette)
npm run e2e:replay -- <dir>        # replay a cassette apps/job recorded (see below)
```

A cassette is a directory with `cassette.jsonl` (one JSON line per interaction: the plan, then each
session) plus `job.json` (the `{ spec, budget, delivery }` needed to drive `runJob`). Each **session**
line carries not only the SDK message stream but the files the session changed under its worktree —
the agent's edits are the point of the build — so replay re-applies them, then the real merges,
`verify`/licence gates, the replayed model gates and delivery run exactly as they would live. The
matcher is deterministic (`systemHashOf`): the **next** unconsumed entry whose kind + system-prompt
hash matches, so parallel tasks (distinct prompts) never collide and a planner retry (same prompt)
still replays in order. Git SHAs and temp paths are normalised out of the hash so it is stable
across the recorded and replayed repos. A request with no recorded entry, or a recorded entry never
replayed, is a clear error.

**Recording** one live build: run `apps/job` with `MF_CASSETTE=<dir>` (or `--record <dir>`). The two
seams pass through to the real client/SDK and every request+response is appended; `job.json` is
written alongside. Normal runs (no flag) are untouched. Then `npm run e2e:replay -- <dir>` replays
it offline forever. The committed fixture under `packages/harness/test/fixtures/cassette/` is a tiny
one-task build used by `e2e.replay.test.ts` (record→replay round-trip + committed-fixture replay);
regenerate it with `MF_WRITE_FIXTURE=1 vitest run …/e2e.replay.test.ts -t "records one build"`.
