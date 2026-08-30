I have enough grounding in the code. The findings are verified and I've confirmed the load-bearing paths (merge.ts serialization with no `git clean`/reset/lock-commit between merges; orchestrator scheduler with no `failed.size` short-circuit; `syncDependencies` never commits the lock). Here is the report.

---

# @mf/harness Orchestrator — Robustness Report

Twelve verified defects. The through-line: **`main` is a single mutable working tree that every serialized merge shares, merges are trusted on `git`'s exit code alone, and no state transition (launch, merge, approval-park) is atomic or age-bounded.** Fix the shared-tree and the merge-verification gaps and most of the merge-integrity class closes at once.

---

## ⚠️ WOULD SILENTLY SHIP AN INCOMPLETE/WRONG APP, OR WEDGE A JOB

These are the ones that either deliver a customer a broken/partial build with every gate green, or leave a paid Fargate task alive forever. Fix first.

### Silently ships wrong/incomplete

1. **Conflict-repair validated by marker-scan only — one branch's behavior is dropped and delivered green.** `merge.ts:116-124` (and the twin at `:118`). A repair session that resolves a conflict by keeping only side B removes all `<<<<<<<`/`=======`/`>>>>>>>` markers, passes `conflictedFiles` + `filesWithConflictMarkers`, is `git add -A`'d and committed (`:132-150`), and fires `completed.add(task)`. If side A's dropped work has no acceptance criterion/test (infra/refactor task), verify stays green and the review gate reviews `seed..HEAD` which no longer contains A's change — nothing flags it. **This is the highest-leverage silent-partial-ship path.**

2. **Merge trusts git's exit code — merged result never built/tested before the next task builds on it.** `merge.ts:85`. A clean textual auto-merge (`merge.code === 0`) returns `syncDependencies` immediately, which only `npm install`s if a manifest changed (`:177`) and never lint/tests the code. Task B calls a helper in `Header.tsx`; parallel task A removes it from `utils.ts`; different files, git merges exit-0, `completed.add(B)`. Dependent task C clones a semantically-broken `main` and either burns budget "fixing" unrelated code or fails. Only caught by the single end-of-run gate, after every merge.

3. **Review gate re-check enforces only `high` after the fix — confirmed mediums the fix didn't resolve ship silently.** `gateSessions.ts:694`. `actionable` = `severity !== 'low'` (`:626`) so a medium triggers the fix session, but the post-fix block is `openHigh = afterFix.filter(f => f.severity === 'high')`. A skeptic-upheld, code-verified medium ("a defect a user will hit") that the fix failed to resolve is never re-blocked; gate returns ok, and `docs.ts:44` surfaces only `low` as a known limitation, so it isn't even disclosed. The entire medium branch of the repair loop is unverified.

4. **Coverage contract is acceptance-criteria only — feature-description behaviors can be dropped and shipped green.** `gateSessions.ts:36` (`criteriaOf` = `spec.features.flatMap(acceptanceCriteria)`). `isSpecComplete` only requires ≥1 criterion per feature. A feature whose description says "create, edit, AND delete bookings" but whose criteria encode only "create" is built to criteria; both acceptance gates test only "create" and pass; edit/delete ship missing. The review gate can't backstop it: a missing feature has no `file:line` to cite (`citationExists`, `:107`), so completeness findings are structurally dropped.

### Wedges a job / leaks a live task

5. **M9 liveness sweep is blind to `task_arn IS NULL` — the exact "stuck queued forever" case it exists to fix.** `jobs.ts:189` (`and task_arn is not null`, mirrored `memory.ts:337`). Launch is non-atomic: `createJob` inserts (`task_arn=NULL`) → `ecs.runJob` (task now booting) → `db.jobs.update({taskArn})` at `jobService.ts:388`. If the api process dies in that window (deploy/OOM/spot-reclaim), the row keeps `task_arn=NULL` forever. The container never writes `task_arn` itself (only the api does — confirmed by grep), so even a job that boots and advances to `building` is excluded from the sweep for its whole life; if that task dies mid-build the job is stuck `building` forever with no terminal status.

6. **Approve-before-deliver park has no timeout — a live Fargate task is held indefinitely, invisible to the sweep.** `orchestrator.ts:260`. After green gates with `approveBeforeDeliver`, `budget.pauseClock()` freezes the wall clock (so `checkDuration` can never trip) and `waitForApproval()` polls every 10s until approved or admin-killed. The row stays `verifying`/`awaiting_approval` with the task `RUNNING`; `runJobSweep` only reaps `STOPPED` tasks and never consults `updated_at`/`awaiting_approval`. No approval → task polls forever, cost leaks, `maxDurationMinutes` permanently suspended. Same blind spot hits any RUNNING-but-wedged container (event-loop-starved duration poll at `orchestrator.ts:27-31`) because there's no heartbeat column to age against.

7. **`syncDependencies` leaves `package-lock.json` uncommitted, dirtying `main` so the next lock-touching merge is refused.** `merge.ts:177`. `npm install` in `repoDir` rewrites the lock but never `git add`/commits; the next `mergeTask`'s only pre-step is `git checkout -q main` (`:79`), which does not clean a dirty tree. Two tasks both adding deps → the second `git merge --no-ff` aborts with "local changes to package-lock.json would be overwritten," yielding `merge.code!=0` with zero conflicted files → treated as hard merge failure (`:88-95`) → a fully-built correct task falsely `failed`, whole job fails. Even without a collision, the delivered repo ships a lock stale vs its `package.json`.

---

## By failure mode

### Merge integrity (the shared-`main`-tree class)

All of these stem from one root: **`main` is one mutable working tree, merges are serialized onto it via `mergeQueue`, and between merges there is only `git checkout -q main` — no reset, no `git clean`, no lock-commit, no lock/transaction, and no build.**

- **[high] Clean merge never verified** — `merge.ts:85`. (WSSI #2)
- **[high] Conflict-repair validated by marker-scan only** — `merge.ts:116` / `:118`. (WSSI #1). Aggravator: `filesWithConflictMarkers` grep (`:26`) omits the diff3/zdiff3 base marker `|||||||` — inert under default conflictStyle, but a latent trap if anyone sets `merge.conflictStyle=diff3`.
- **[high] Uncommitted lock dirties main** — `merge.ts:177`. (WSSI #7)
- **[medium] Aborted repair leaves untracked files in main's tree, poisoning later merges** — `merge.ts:126`. `git merge --abort` restores tracked files but not untracked scratch files the repair agent created; no `git clean`. Later branch adding a file at that path → "untracked working tree files would be overwritten by merge" (good task falsely failed); or a later repair's `git add -A` (`:132`) stages the stale scratch into the wrong integration commit.
- **[medium] Post-merge `npm install` failure reported as failed task while its commit stays in main** — `merge.ts:183`. `mergeTask` commits the merge (`:85`/`:150`) *before* `syncDependencies`; on install failure it returns `{ok:false}` with **no `git merge --abort`/reset** — unlike every other failure path. The task is counted `failed` (dependents blocked) but its code is in `main`, and the next serialized merge layers on top. No retry anywhere on a transient/recoverable registry blip → whole build wasted, task accounting decoupled from the git tree.

**Systemic fix for the whole class** — three changes, roughly in impact order:

1. **Verify every merge before accepting it.** After both the clean path (`merge.ts:85`) and the repaired-commit path (`:150`), run the scoped lint/test gate (`gateScopeForChanges` over the merged diff) *inside* `mergeTask`, before returning ok. On red, `git reset --hard` + `git clean -fd` back to the pre-merge HEAD and return `{ok:false}`. This closes #1, #2, and the "next task builds on a broken main" propagation in one move — the merge step becomes the verification point it structurally should be.
2. **Make `main` clean and committed between every merge.** At the top of `mergeTask`, before `git checkout -q main`: `git reset --hard HEAD && git clean -fd` (closes the untracked-poison #4 and the dirty-lock #7). And in `syncDependencies`, after a successful `npm install`, `git add -A package-lock.json package.json && git commit --amend --no-edit` (or a follow-on commit) so the lock is never left uncommitted (also closes #7's "ships a stale lock").
3. **Never leave a rejected merge's commit in main.** On the `syncDependencies` install-failure return (`merge.ts:183`), `git reset --hard HEAD~1` (or `git merge --abort` equivalent) so a rejected task's manifest cannot flow into later merges (#5-merge). Add one bounded retry around the `npm install` for transient registry failures.

A stronger structural option that subsumes #1: **merge onto a throwaway integration branch, gate it, and fast-forward `main` only on green** — makes "main is always a gated, buildable tree" an invariant rather than a hope.

### Repair-loop

- **[high] Review gate re-blocks only `high`** — `gateSessions.ts:694`. (WSSI #3). **Fix:** re-block on any finding whose `severity` was `actionable` pre-fix and survives the refute pass — `afterFix.filter(f => f.severity !== 'low')`, matching `isActionable` (`:626`) and the skeptic prompt (`review.ts:137`, "high/medium fail closed"). At minimum, surface unresolved confirmed mediums as known-limitations (`docs.ts:44`) instead of dropping them.
- **[medium] Gate fix sessions abandon on turn-cap without re-verifying** — `gateSessions.ts:308` (acceptance) and `:652` (review). Both do `if (!fix.ok) return {ok:false}`, and `runSession` sets `ok=false` on `error_max_turns`. A fix that finished its edits but hit the cap on a trailing `npm test` turn is discarded; the gate never re-runs `verifyAcceptance`/`verifyRepo` to see it's green. **This contradicts the worker's own policy** at `worker.ts:1075`/`:1103`, which guards with `!first.ok && !first.maxTurnsReached` precisely because capped work is often good. **Fix:** add `&& !fix.maxTurnsReached` to both guards; on a capped session, `commitAll` the working-tree edits and fall through to the existing `verifyAcceptance`/`verifyRepo` re-check as the arbiter.

### State resumption / liveness

- **[high] Sweep blind to `task_arn IS NULL`** — `jobs.ts:189`. (WSSI #5). **Fix (two parts):** (a) make launch atomic — write `task_arn` in the same transaction as the status flip, or have the *container* write its own `task_arn` on boot (it currently never does); (b) add an **age-only compensating sweep**: any job in an active status (`queued`/`planning`/`building`/`verifying`) with `updated_at` older than a threshold and no live ECS task is failed regardless of `task_arn` being NULL. That single age-based sweep is the real backstop for the whole "stuck active forever" class.
- **[medium] Approval park has no timeout / no heartbeat** — `orchestrator.ts:260`. (WSSI #6). **Fix:** add an approval TTL (abort the park after N hours → terminal `failed`/`cancelled`), and add a `last_progress_at` heartbeat column the orchestrator bumps each phase so the sweep can age out any RUNNING-but-wedged container, not just STOPPED tasks. The heartbeat also covers the event-loop-starved case at `orchestrator.ts:27-31`.

### Budget accounting

- **[low] Scheduler keeps launching and paying for tasks after the outcome is sealed `failed`** — `orchestrator.ts:196`. First `failed.set(id)` guarantees the job returns `failed` (`:216`), but the scheduler loop (`:196-208`) has no `failed.size` short-circuit — a wide plan (1 foundation + 8 features, feature #2 fails early) still runs full worker sessions for #3-#8, burning near the whole `maxTokens` on a doomed build. **Fix:** stop launching *new* tasks once `failed.size > 0` (let running ones drain for aggregate reasons) — add `&& failed.size === 0` to the `start`-selection guard, or break the launch loop while allowing `Promise.allSettled` on in-flight tasks. Preserves the "surface all failures" intent for tasks already running while capping the doomed spend.

### Concurrency race

- **[low] Multi-instance sweep appends duplicate `failed` events** — `jobSweep.ts:45`. Two api instances (desiredCount=2) can both `DescribeTasks` the same dead job in overlapping windows; the `status <> 'killed'` guard (`jobs.ts:233`) doesn't exclude an already-`failed` row, so the second `update` returns a row and `appendEvent(... {type:'failed', sweep:true})` inserts a *second* failed event (plain `appendEvent`, not the `(job_id, seq)`-deduped `appendEventOnce`). Cosmetic — duplicated timeline event + inflated counter. **Fix:** use `appendEventOnce` keyed on `(job_id, 'sweep-failed')`, or gate the whole `failDeadJob` write behind `SELECT … FOR UPDATE` / a conditional `UPDATE … WHERE status IN (active states) RETURNING` so only the first writer proceeds.

---

## Systemic fixes that close whole classes

1. **A merge-time verification gate (gate-on-merge, or merge-to-integration-branch-then-fast-forward).** Closes clean-merge-unverified (#2), conflict-repair-lossy (#1), broken-merge-propagation, and turns "main is always buildable" into an invariant. Single highest-value change.
2. **Clean + commit `main` between every serialized merge** (`reset --hard` + `clean -fd` before, lock-commit after). Closes untracked-poison (#4), dirty-lock refusal (#7), and orphaned-rejected-commit (#5-merge). These bugs exist *only* because the shared tree is never reset between the serialized `mergeQueue` steps.
3. **An age-only / heartbeat-based liveness sweep** keyed on `updated_at`/`last_progress_at` rather than `task_arn`+ECS-STOPPED. Closes the `task_arn NULL` blind spot (#5), the indefinite approval park (#6), and any RUNNING-but-wedged container — the entire "job stuck in an active status forever" class. Add a `last_progress_at` column and an approval TTL alongside it.
4. **Atomic launch state transition** (write `task_arn` in the same txn as job insert, or container self-registers its `task_arn`). Removes the non-atomic api-death window at `jobService.ts:387-388` that seeds most orphaned rows.
5. **A completeness gate before delivery keyed on feature descriptions, not just criteria.** Closes the description-coverage gap (#4-ship). Either require criteria to cover their own description at freeze (`isSpecComplete`), or add a delivery-time check that each feature's description behaviors map to a passing acceptance test.
6. **Re-block the repair loop on the same severity set it acts on** (`!== 'low'`, `gateSessions.ts:694`) and re-verify capped fix sessions (`&& !fix.maxTurnsReached`, `:308`/`:652`). Closes both repair-loop defects — the loop currently *acts* on mediums and capped sessions but *judges* on neither.

Key files: `packages/harness/src/job/merge.ts`, `packages/harness/src/job/orchestrator.ts`, `packages/harness/src/job/gateSessions.ts`, `packages/db/src/jobs.ts`, `apps/api/src/lib/jobSweep.ts`, `apps/api/src/services/jobService.ts`, `packages/harness/src/job/worker.ts`.