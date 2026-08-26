# Worker token efficiency

Where a build job's tokens go, and the levers in `packages/harness/src/job/worker.ts`
(`workerLimits`). Written 2026-08-27 from the code and the recorded runs below; nothing here has
been re-measured on a live job yet — every saving is an estimate until the next M10 dogfood run.

## The numbers we have (S demo spec, claude-sonnet-5 workers)

Budget-tokens = input + output + cache writes + 10 % of cache reads (`cacheReadWeight`).

| Run | Task | Turns | Budget-tokens | USD | Per turn |
|---|---|---|---|---|---|
| local job #5 | task 1 | 42 | 190k | 0.50 | 4.5k |
| local job #5 | task 2 | 119 | 1.25M | 3.19 | 10.5k |
| Fargate 266a218a | 4 tasks | 86 + ~120 + ~60 + ~80 ≈ 346 | 2.54M | ≈ 6.5 | 7.3k |

44 min wall clock for the Fargate job, most of it the workers waiting on `npm run lint` /
`npm test` of the whole template monorepo.

## Where the turns go

A "turn" is one assistant message in the Agent SDK stream (`runSession` counts them by message
id). Every turn resends the whole conversation: system prompt + tool definitions + every tool
call and tool result so far. The SDK marks that prefix with `cache_control`, so the resend is
billed as a cache read (10 %) — which is exactly why the per-turn cost grows linearly with the
session: **turn cost ≈ 0.1 × context size + new tool output (written to cache at 1.25×) + output
tokens**. Task 2 above at 10.5k budget-tokens/turn means its context was ~80–100k tokens for most
of the session; task 1 at 4.5k/turn stayed around 30–40k.

What fills the context, from the message stream shape of a worker session:

1. **System prompt** (~3–4k tokens: task + plan + rendered spec + conventions). Paid once as a
   cache write, then 10 % per turn. Cheap by itself, but it is the *prefix* — anything that varies
   in it between sessions invalidates the cache for the repair session.
2. **The first prompt said "start by reading CLAUDE.md"** — the template CLAUDE.md is 14.5 kB
   (~4k tokens) and the worker usually followed it with `.claude/rules/*.instructions.md`
   (another 2–6k). That is 6–10k tokens that sit in the context for the rest of the session:
   ~1k budget-tokens on every later turn, i.e. 5–10 % of the whole task.
3. **Exploration reads** (Read/Glob/Grep of the template): 15–40 tool calls in a typical session,
   each result 0.5–3k tokens. Unavoidable, but the reads are what the conventions above were
   meant to save; with concrete task descriptions from the planner the worker needs fewer.
4. **Gate runs.** The system prompt told the worker that done means the *full-repo* `npm run
   lint` and `npm test` pass, and the template's root `lint` fans out to every workspace (eslint +
   stylelint + tsgo per workspace), `test` to every Vitest project. From the event logs the
   workers ran the full gate 3–6 times per task (after scaffolding, after each fix, "once more to
   be sure"). Each run is: one turn to launch (~1–2 min of wall clock at 0 tokens), then the
   output — a green run is ~1–2k tokens, a red one with eslint/tsc noise easily 5–10k, and it stays
   in the context. Four red-ish gate runs ≈ 20–30k tokens of permanent context ≈ 2–3k budget-tokens
   per subsequent turn. Then the harness ran the full gate again in `verifyRepo`.
5. **Fix loops after the gate**: the tail of the long sessions is edit → lint → edit → lint,
   1 turn per step with the full-repo lint each time. This is where task 2's 119 turns came from
   (task 1 did the same work in 42).
6. **No cap that the worker knows about**: `maxTurns` was 200 for every task regardless of size;
   a session that lost the thread could burn 200 turns before the orchestrator saw anything.

So, roughly, for the 119-turn task: ~35 % of the budget-tokens is the prefix (system prompt +
CLAUDE.md + rules) being re-read, ~30 % gate output being re-read, ~25 % genuine reads/edits and
~10 % output tokens.

## Levers

| # | Lever | Where | Expected saving | Risk |
|---|---|---|---|---|
| 1 | Scope the task gate to the `apps/*` workspaces in `task.areas` (`npm run lint -w <ws>`, `npx vitest run <ws>`), **widened to the full gate by the task's actual diff**: `git diff --name-only main...HEAD` in the worktree, any changed path outside the scoped workspaces (packages/*, another app, a root config) → full gate; full gate always at merge/verify | `gateScopeForAreas`, `gateScopeForChanges`, `changedFiles`, `gateCommands`, `verifyRepo({ areas, changed })`, `workerLimits.scopedTaskGate` | 60–80 % of gate wall clock per run (1 workspace instead of 5) and 40–60 % of the gate output in context (no unrelated eslint/tsc noise) for the tasks that stay inside their workspace. Per task: −10–20 % tokens, −30–50 % minutes | The planner's `areas` are only a hint for the worker prompt; the harness gate keys off what was changed, so an `apps/api` task that adds a schema to packages/models is gated full-repo (noted as `gate widened…` on the task outcome). A scoped Vitest run that collected nothing while the workspace holds test files is red with a hint (unregistered project), not a vacuous `--passWithNoTests` pass. The worker itself may still run only the scoped commands and get a surprise from the harness gate — that is what the repair session is for. |
| 2 | "Run the gate at most twice; use `tsgo --noemit` while iterating; never the full-repo gate when the scoped one covers you" in the system prompt | `workerSystemPrompt` "Working efficiently" | Turns 3–6 gate runs → 2; with the tsgo iterations at seconds instead of minutes: −20–40 % turns on the long tail (task 2 type sessions), ~0 on the short ones | Instruction only — the model may still over-check. The turn cap makes it bounded. |
| 3 | Trim the conventions to what a task needs; CLAUDE.md/rules become "read if needed" pointers, first prompt no longer says "read CLAUDE.md" | `taskConventions`, `workerSystemPrompt` | −6–10k tokens of permanent context → −5–10 % of every long session; fewer exploration reads at the start | The worker misses a convention it would have read. The eslint/prettier config catches formatting; the reviewer gate catches the rest. Gate sessions and merge keep the full `repoConventions`. |
| 4 | `maxTurns` per task by size: S 60 / M 100 / L 150 (was 200 flat), one second session of 60 turns as the safety valve — it runs after a capped session **whether the gate is red (repair, with the output) or green (finish the task against its acceptance criteria)**. Every cap hit is a `turn cap reached` log line and a note on the task outcome (`notes` in the `task_finished` payload, appended to the `task_failed` reason) | `workerLimits.maxTurnsBySize`, `maxTurnsForSpec`, `runTask` | Bounds the worst case: an S task can no longer spend 200 turns (≈ 2M budget-tokens); a capped session is committed and gated, and the second session finishes the last mile. The notes are what the next dogfood run reads to tune the caps (turns per task, cap hits) | A legitimately long task is cut off and the second session has to finish it with only the commit history as context. The size class is the price estimate's, so the customer's budget and the cap agree. |
| 5 | Prompt caching: the SDK marks system prompt + tools + prefix with `cache_control` by itself; the harness strips every `DISABLE_PROMPT_CACHING*` kill switch from the session env (`sessionEnv`) and keeps the system prompt byte-identical between a task's two sessions (same `scope`, computed once). Nothing verifies caching is actually on — that is the `cache_read_input_tokens > 0` check below, to be confirmed on the dogfood run | `sessionEnv`, `runTask` | No change vs today when caching was on (the 10 % weight assumes it); a 10× input-cost protection if the kill switch ever leaks in. Second session starts from a warm cache instead of re-writing the prefix (~4k tokens × 1.25) | None from the code; the assumption that the SDK caches is unverified until measured. |
| 6 | Effort: the SDK's `effort` option, default untouched, `WORKER_EFFORT=low|medium|high|xhigh|max` env or `runSession({ effort })` per session | `resolveEffort` | Unknown for our workload — Anthropic's guidance is that `medium` cuts thinking tokens and tool-call chatter on routine tasks; output tokens are ~10 % of our spend, so the bigger effect would be fewer turns. To be A/B'd on the dogfood run, not enabled by default | Lower effort → more repair sessions. Keep at the model default until measured. |

Not touched, by design: the budget weights and pricing (`cacheReadWeight`, size budgets), the
M4 gate sessions and their prompts, the merge session.

## How to measure the next live job

`runSession` logs `session result` per session with `turns`, `streamedTokens`, `reportedTokens`
and `costUsd`; the job events carry `tokens` and `durationMs` per task. Compare against the table
above for the same S demo spec:

- turns per task (target: task-2-type sessions < 70),
- budget-tokens per turn (target: < 7k — a smaller context),
- gate runs per task (grep the Bash tool calls for `vitest`/`lint`; target ≤ 2 by the worker + 1 by
  the harness),
- `cache_read_input_tokens` > 0 from the second turn of every session (caching on — assumed, not
  verified, until this is seen on a live run),
- `turn cap reached` log lines / `notes` on `task_finished` events (cap hits per size class),
- wall clock per task.

Then flip one knob at a time (`workerLimits`, `WORKER_EFFORT`) and re-run; append the numbers to
TOKENS.md and this file.
