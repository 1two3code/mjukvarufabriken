# Orchestrator correctness & reliability audit — `packages/harness` + `apps/job`

Read-only pass over the review worktree at `review/deep-audit-2026-08-31` (HEAD `8574129`). Prior art read first: `docs/M3-BRIEF.md`, `docs/M3-REVIEW.md`, `docs/EFFICIENCY.md`, `docs/LEARNINGS.md`, `docs/DUE-DILIGENCE-2026-08-31.md`, `PLAN.md`, `docs/backlog/*` including the four 2026-08-30 hardening sweeps. Findings below are **new** unless marked otherwise; sweep‑4 (orchestrator) and sweep‑1 (delivery) items are re-confirmed as still-open only in `Docs-vs-code drift`.

## Verdict

The orchestrator's *control flow* is in good shape — abort plumbing, fail-closed gate chaining, merge serialization, budget arithmetic and the reporter's retry/queue semantics are all deliberate and mostly well-tested. What is weak is everything that decides **whether a green result is real**: the gates run the customer repo's own `npm run lint`/`npm test`, and nothing pins those scripts or the root Vitest `projects` list, so a worker can quietly shrink the gate's coverage and stay green. Two paths produce a *silently wrong* delivery today: the licence manifest the customer contract references is deleted by the next gate before delivery ever commits it (ORC‑01), and an empty `seedCommit` turns the entire review gate into a no-op that reports green (ORC‑02). On the money side, the spec chat has no turn cap or rate limit (unbounded Anthropic spend per order, ORC‑08), the size class that fixes both price and budget is a negation-blind keyword match the team already documents gaming (ORC‑09), and a delivery that fails after the push orphans a live, billing ECS service with no record anywhere (ORC‑05). Finally, `exec` captures child output into an uncapped string and `apps/job` has no `uncaughtException` handler — model-written test code can therefore kill the container with no terminal status write, after the full budget is spent (ORC‑04).

---

## Critical

### ORC-01 — The licence manifest is deleted by the next gate; every delivered repo is missing the file HANDOVER.md promises

**Location.** [licence.ts:386](../../packages/harness/src/job/gates/licence.ts#L386), [gateSessions.ts:752](../../packages/harness/src/job/gateSessions.ts#L752) → [gateSessions.ts:121](../../packages/harness/src/job/gateSessions.ts#L121), [docs.ts:128](../../packages/harness/src/job/delivery/docs.ts#L128)

```ts
// licence.ts:386 — written to the working tree, never committed
await writeFile(join(repoDir, licenceFileName), renderLicenceFile(entries, now(), missing))
```
```ts
// gateSessions.ts:752 (acceptanceCheckGate, the gate that runs *after* licence)
await discardChanges(repoDir, snapshot)
// gateSessions.ts:121
await exec('git', ['clean', '-qfd'], { cwd: repoDir })
```

**Failure scenario.** `gateOrder` is `verify → acceptance-tests → review → licence → acceptance-check` ([Job.ts:83](../../packages/models/schemas/Job.ts#L83)). The licence gate writes `THIRD-PARTY-LICENCES.md` as an **untracked** file (it does not exist in `templates/web`, verified) and explicitly relies on "delivery commits it with the other docs". The very next gate is `acceptance-check`, whose mandatory post-session cleanup runs `git clean -qfd`, which deletes exactly that untracked root file. `deliver()`'s `commitDocs` (`git add -A`) runs afterwards and finds nothing. Every delivered repo, every `repo.zip` (`git archive main`) and every debug bundle therefore ships without it, while [docs.ts:128](../../packages/harness/src/job/delivery/docs.ts#L128) tells the customer "Every installed package … is listed in `THIRD-PARTY-LICENCES.md`" and HANDOVER's gate table shows `licence: ok`.

**Blast radius.** Corrupt delivery + contractual exposure: `kundavtal §9.2` is the reason the gate exists, and the only surviving evidence of the scan is a summary string in `jobs.gates`. Completely silent — no gate, test or log line notices. This affects **every job ever delivered**, including the three real deliveries.

**Fix.** Commit the file in the licence gate itself (`git add THIRD-PARTY-LICENCES.md && git commit`) rather than deferring to delivery; or add it to `isProtectedTestPath`-style restore. Minimal robust version: have `deliver()` regenerate it (call `renderLicenceFile` from the stored `LicenceGateDetails`) before `commitDocs`, and add a `deliver.test.ts` case asserting `THIRD-PARTY-LICENCES.md` is in the committed tree.

---

### ORC-02 — An empty `seedCommit` silently makes the review gate review nothing, and it reports green

**Location.** [index.ts:167](../../apps/job/src/index.ts#L167), [gateSessions.ts:594](../../packages/harness/src/job/gateSessions.ts#L594)

```ts
// apps/job/src/index.ts:167 — exec() never throws; a failure yields code -1 and stdout ''
const seedCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim()
```
```ts
// gateSessions.ts:594 — `??` does not catch the empty string
const seed = input.seedCommit ?? (await rootCommit(repoDir, signal))
const range = `${seed}..HEAD`
```

**Failure scenario.** Any failure of that one `rev-parse` (a `.git` permission problem after `protectGitDir`, an `index.lock`, a spawn failure, an aborted signal) leaves `seedCommit === ''`. It is not `undefined`, so the `rootCommit` fallback never fires and `range` becomes `'..HEAD'`. Git resolves an empty revision to `HEAD`, so `git diff ..HEAD` is **an empty diff**. The reviewer session is asked to review nothing, correctly returns `findings: []`, `actionable.length === 0`, and the gate returns `ok: true` with `"0 finding(s), none high/medium open"`. The skeptic pass is skipped (nothing to refute). The job proceeds to delivery with the security/correctness gate having examined zero lines.

**Blast radius.** Silent wrong result: an entire build ships with the independent-review gate structurally bypassed, and the gate report, the portal and HANDOVER all say it passed. The same `''` also poisons `remapWaivers` and every `git diff -U0 ''..HEAD`.

**Fix.** Two one-liners: `input.seedCommit || (await rootCommit(...))` in `reviewGate`, and `execOrThrow`/an explicit `if (!seedCommit) throw` in `apps/job`. Additionally reject a `range` whose `git diff --name-only` is empty as a red gate ("nothing to review" is never a legitimate green after a build).

---

### ORC-03 — The gate is the repo's own `npm run lint` / `npm test`, and nothing pins what those cover

**Location.** [worker.ts:474](../../packages/harness/src/job/worker.ts#L474), [worker.ts:487](../../packages/harness/src/job/worker.ts#L487), [gateSessions.ts:132](../../packages/harness/src/job/gateSessions.ts#L132)

```ts
// worker.ts:487 — the vacuity check exists ONLY in the scoped branch
if (step.script === 'test' && 'workspaces' in scope && output.includes(noTestFilesMarker)) {
```

**Failure scenario.** `verifyRepo` shells out to the template's root scripts: `"lint": "npm run lint --workspaces --if-present"` and `"test": "vitest run"` over `vitest.config.ts`'s `projects: ['apps/api', 'packages/utils']`. Three cheap mutations make a red repo green, none of them detected:

1. Delete a workspace's `lint` script — `--if-present` skips it silently.
2. Remove a workspace from the root `projects` array — `vitest run` still finds the other project, exits 0, and never prints `No test files found`.
3. Rewrite the root `"test"` script entirely.

`isProtectedTestPath` (`package.json`, vitest configs, setup files) exists and works — but `restoreProtectedPaths` is called from **exactly one place**, the acceptance-tests fix session ([gateSessions.ts:311](../../packages/harness/src/job/gateSessions.ts#L311)). The 12 task workers, the merge repair session and the review fix session ([gateSessions.ts:637](../../packages/harness/src/job/gateSessions.ts#L637)) are all free to edit those files, and the full-repo gate (used at merge, at gate #1, and after the review fix at [gateSessions.ts:652](../../packages/harness/src/job/gateSessions.ts#L652)) has no vacuity check at all — only the scoped path does.

**Blast radius.** Silent wrong result. A worker that cannot get `apps/api` green drops it from `projects`; every subsequent gate is green, the delivered repo's CI is green, and an entire workspace is untested. The acceptance-tests gate is unaffected (it runs its files explicitly through `runAcceptanceTests`), so only the *criteria* remain verified — every other behaviour the workers wrote tests for silently stops being checked.

**Fix.** Snapshot the gate contract at `seedCommit`: the set of workspaces with a `lint` script, the root `test` script, and the root Vitest `projects` list. In `verifyRepo`, fail closed when the current repo covers strictly fewer workspaces than the seed, and extend the `hasTestFiles` orphan check ([worker.ts:487](../../packages/harness/src/job/worker.ts#L487)) to the full scope. Cheaper interim: add `restoreProtectedPaths(repoDir, seedCommit)` after every session that runs in `repoDir`.

---

### ORC-04 — Uncapped child-process output + no `uncaughtException` handler: model-written test code can kill the container after the whole budget is spent

**Location.** [exec.ts:249-250](../../packages/harness/src/job/exec.ts#L249), [index.ts:152-153](../../apps/job/src/index.ts#L152)

```ts
// exec.ts:249 — no maxBuffer, no cap; `tail()` only trims at the very end
child.stdout.on('data', chunk => (stdout += String(chunk)))
child.stderr.on('data', chunk => (stderr += String(chunk)))
```
```ts
// apps/job/src/index.ts:152 — SIGTERM and unhandledRejection only
process.on('SIGTERM', () => void fail('SIGTERM received'))
process.on('unhandledRejection', error => void fail(`unhandled: ${(error as Error).message}`))
```

**Failure scenario.** Every customer-repo command goes through `exec`: `npm run lint`, `npm test`, `npx vitest`, `npm ls --all --json --long`, `npm run build`. All of them execute model-written code with a 15-minute default timeout. A generated test with a logging loop (or a `console.log` inside a `beforeEach` over a large fixture) streams unbounded output into a growing JS string in the **job** process. Two outcomes: (a) heap exhaustion → the Fargate task is OOM-killed; (b) past V8's max string length, `stdout += …` throws `RangeError: Invalid string length` **inside a stream `'data'` listener**, which is neither a promise rejection nor a `SIGTERM` — it becomes an `uncaughtException`, which nothing handles, so Node prints and exits.

Either way `fail()` never runs, no `failed` event is emitted, and the terminal `setStatus` never happens. The row stays `building`/`verifying` until the M9 sweep sees a STOPPED task — and the sweep is still blind to `task_arn IS NULL` (sweep‑4 #5, open).

**Blast radius.** Wasted spend (the crash happens at the *final* verify or a late gate, i.e. after most of a 6–40 M-token budget), a job wedged in an active status, and the order blocked by `jobAlreadyActive` until an admin intervenes. Also a trivially reachable self-DoS from a hostile spec.

**Fix.** Cap the capture in `exec`: keep a rolling window (`if (stdout.length > MAX) stdout = stdout.slice(-MAX)`, e.g. 4 MiB) — the only consumers are `tail()` and `jsonFromOutput`, both of which want the end (`jsonFromOutput` wants the start of the JSON; give the vitest-JSON path its own larger cap or write to a temp file). Separately, register `process.on('uncaughtException', …)` next to the existing handlers in `apps/job` so *any* synchronous throw still writes a terminal status.

---

## High

### ORC-05 — A delivery failure after the push orphans a live, billing ECS Express service with no record of it anywhere

**Location.** [deliver.ts:224](../../packages/harness/src/job/delivery/deliver.ts#L224), [deliver.ts:254](../../packages/harness/src/job/delivery/deliver.ts#L254), [deliver.ts:281](../../packages/harness/src/job/delivery/deliver.ts#L281)

```ts
deployedService = deployed.service        // :224 — held in a local only
…
const files = await uploadBundle({ … })   // :254 — throws → fail(`bundle: …`)
…
return { ok: true, tokens, deliverable, … } // :281 — the ONLY path that surfaces deployedService
```

**Failure scenario.** The steps are docs → repo → deploy → bundle. `deployedService` — the record the api uses to teardown/resume a customer's services — is only ever handed out inside the `Deliverable` built in the bundle step. If `uploadBundle` throws (S3 5xx, an expired assumed-role session after a 20-minute CodeBuild wait, `git archive` failing), `deliver` returns `{ok:false}`; `runJob` marks the job `failed`. The same happens for the `if (aborted()) return aborted()!` immediately after the deploy step — a kill or budget breach landing there.

**Blast radius.** Real money leak plus an operational orphan: the GitHub repo is pushed and world-visible to the collaborator, an ECS Express service is `ACTIVE` and billing indefinitely, and neither the portal, the `Deliverable`, nor the per-order deployed-service registry knows it exists. The `Customer=<slug>` fence check at deploy time exists precisely to make teardown possible — and this path defeats it by never recording the service.

**Fix.** Emit the `deployedService` on the `deploy` step event (`step({ step:'deploy', …, deployedService })`) so the api records it the moment it exists, independent of the bundle outcome; and make a post-push failure return a *partial* deliverable (`ok:false` but with `repositoryUrl`/`deployUrl`/`deployedService`) rather than dropping it.

---

### ORC-06 — The licence gate is fail-open for every package npm did not install

**Location.** [licence.ts:273-279](../../packages/harness/src/job/gates/licence.ts#L273)

```ts
if (node.missing || !node.version) {
    if (name) missing.add(`${name}@${node.version ?? '?'}`)
    for (const [childName, child] of Object.entries(node.dependencies ?? {})) { … }
    return                      // ← never reaches the licence read or the violation loop
}
```

**Failure scenario.** `missing` entries are listed in the summary and in `THIRD-PARTY-LICENCES.md` under "Not installed on the build platform", but they are never evaluated against `deniedFamily`/`noLicence` and never become violations. The gate returns `ok: true`. The live-verified dev run (`486113ca`, PLAN.md M4) reported `"637 package(s), 14 licence(s), none denied; 57 not installed here…"` — 57 unchecked packages, still green. Those packages are pinned in the delivered `package-lock.json` and *will* install in the customer's environment and in the CodeBuild image.

**Blast radius.** Silent wrong result with legal weight: the gate exists to back `kundavtal §9.2`, and its own summary shows the hole every time it runs. An optional/platform-gated GPL dependency ships unflagged.

**Fix.** Read the licence from the lockfile for `missing` entries (`package-lock.json` `packages[].license` is present for most registry packages), or — deterministically and cheaply — treat any `missing` entry as `UNKNOWN` and therefore a violation waivable per `licence:<pkg>@<version>`, matching how unreadable manifests are already handled. At minimum, fail the gate when `missing.length > 0` and no waiver covers it, instead of noting it in prose.

---

### ORC-07 — The review-fix session can mutate anything, and no deterministic acceptance re-check follows it

**Location.** [gateSessions.ts:637-652](../../packages/harness/src/job/gateSessions.ts#L637), contrast [gateSessions.ts:311](../../packages/harness/src/job/gateSessions.ts#L311)

```ts
const fix = await runSession({ cwd: repoDir, systemPrompt: reviewFixSystemPrompt(...), maxTurns: 120 })  // full worker tools
…
await commitAll(repoDir, 'fix(review): address review findings (auto-commit)', signal)
const verification = await verifyRepo(repoDir, signal)   // lint + test only
```

**Failure scenario.** The acceptance-tests gate treats its tests as the contract and restores them after its fix session (`restoreProtectedPaths`, `:311`). The review gate's fix session has the same tools in the same directory and **no such restore**, and afterwards only `verifyRepo` runs — `runAcceptanceTests(repoDir, testFiles)`, the deterministic per-criterion check, is never re-run. A fix session that changes app behaviour to close a finding, and in doing so breaks or deletes an acceptance test, produces a green `npm test` (deleted tests don't fail). The only remaining backstop is `acceptanceCheckGate`, a read-only *model* judgement.

**Blast radius.** The last deterministic proof that the acceptance criteria hold predates the last mutation of the application. Silent — the gate table shows both acceptance gates green.

**Fix.** Call `restoreProtectedPaths(repoDir, <commit before the fix>)` after the review fix, and replace the `verifyRepo` re-check at `:652` with `verifyAcceptance(repoDir, testFiles, signal)` (the acceptance file list is recoverable via `findAcceptanceTests`).

---

### ORC-08 — The spec chat has no turn cap and no rate limit: unbounded Anthropic spend per order, and a draft that bricks itself

**Location.** `apps/api/src/services/specService.ts` (`sendMessage`), [specEngine.ts:150](../../packages/harness/src/spec/specEngine.ts#L150) (`toMessageParams`), `Spec.api.ts:7`

```ts
// specEngine.ts — every turn resends the entire conversation
const toMessageParams = (messages: ChatMessage[], userMessage: string) => [
    ...messages.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userMessage },
]
```
```ts
PostSpecMessage: z.object({ content: z.string().trim().min(1).max(8000) }).strict()
```

**Failure scenario.** Per-message content is capped at 8 000 chars; the **number** of messages is not, and nothing truncates or summarises. Cost per turn grows linearly with the conversation, so total cost per order grows quadratically. `contactService` has `contactRateLimit = { max: 5, globalMax: 60, windowMinutes: 10 }` and `authService` has a magic-link limit — the one endpoint that spends real Anthropic tokens on every call has neither. `POST /bff/orders` mints orders freely, so this multiplies.

There is a second, deterministic failure at the end of it: once `messages` exceeds the model's context window, `client.messages.create` returns a 400 forever, `reply.error(500, error, 'specEngineFailed')` on every subsequent message, and the draft is permanently unusable — there is no truncation, no reset and no "start over" path.

**Blast radius.** Wasted spend on a customer-controlled loop, plus a stuck order that no UI action can recover. This is the exact scenario the brief asked about; the answer is yes.

**Fix.** Cap `draft.messages.length` (e.g. 40 turns) with a clear `409 specConversationTooLong`, add a `specChatRateLimit` in `db.rateLimits` scoped to `(orgId, orderId)` mirroring `contactRateLimit`, and window the history sent to the model (keep the system prompt + `draftContext(draft.spec)` — which already carries the accumulated state — plus the last N turns).

---

### ORC-09 — The size class fixes price, budget *and* turn caps from a negation-blind keyword match over customer-authored text, and is never re-checked

**Location.** [priceEstimator.ts:29-66](../../packages/harness/src/spec/priceEstimator.ts#L29)

```ts
const allText = (spec: PartialSpec) =>
    [spec.goal ?? '', ...(spec.features ?? []).map(featureText), ...(spec.stackConstraints ?? [])].join('\n')
…
const isLarge = features.length >= largeMinFeatures || hasPayments(spec) || hasAuthWithRoles(spec)
    || countIntegrations(spec) >= largeMinIntegrations || hasRealtime(spec)
```

**Failure scenario.** Three distinct defects in one function:

1. **Gameable downward.** The class is a regex match over text the customer writes. Rewording "checkout with Stripe" as "the guest confirms their basket" drops an L spec to S. This is not hypothetical — `PLAN.md` records dogfood app #3 being worded deliberately to dodge the L triggers, with a "keyword hygiene note" for future editors. The consequence is not only price: `budgetForSize` (S 6 M / M 15 M / L 40 M tokens) and `workerLimits.maxTurnsBySize` (S 80 / M 120 / L 160) both key off it, so an L-shaped build classified S gets S turn caps, gets cut off, spills into the 60-turn repair valve, and most likely fails — after spending the whole S budget.
2. **Inflates on negation.** `allText` includes `stackConstraints` but the patterns have no negation handling: "must not integrate with Stripe" matches `paymentsPattern` → L → 120 000 SEK. `nonGoals` is correctly excluded; `stackConstraints` is not.
3. **Never re-validated.** Nothing compares the frozen class against the plan the planner actually produces. A spec priced S that yields a 12-task plan is built at full cost with no signal.

**Blast radius.** Money in both directions, plus a wasted-budget failure mode for the under-classified case.

**Fix.** (a) Exclude negated clauses (a `\b(no|not|inte|ingen|utan)\b` window before a trigger) or drop `stackConstraints` from `allText`. (b) After planning, compare `plan.tasks.length` and `criteriaOf(spec).length` against the frozen class and emit a `notify` (or fail closed) on a mismatch — a cheap pre-flight that saves a whole job's spend. (c) Treat the estimator as advisory and require a human/admin confirmation for any class change at freeze.

---

### ORC-10 — `runJob` treats "no task can run" as "the build is finished" and proceeds to the gates

**Location.** [orchestrator.ts:196-213](../../packages/harness/src/job/orchestrator.ts#L196)

```ts
const ready = readyTasks(plan.tasks, settled, new Set(running.keys())).filter(…)
const slots = job.budget.maxWorkers - running.size
ready.slice(0, Math.max(0, slots)).forEach(start)
if (running.size === 0) break            // :208 — no ready task, nothing running → give up
…
if (budget.aborted) return abortedOutcome(plan)
if (failed.size) { … }                   // :215 — 0 failures, so fall through to the gates
```

**Failure scenario.** If a plan contains a cycle (or any unreachable component), `readyTasks` returns `[]` on the first iteration, `running.size === 0`, the loop breaks, `failed.size === 0`, and the job runs the full gate chain — including delivery — on a repository where **no task ever ran**. `runJob` never calls `validateDag` on the plan it is handed; the only validation is inside `createPlanner.parsePlan`, so the invariant depends entirely on which `ports.plan` implementation is wired (the replay/cassette path, `gates-demo`, and any future resume path bypass it).

Because the review gate diffs `seedCommit..HEAD` (empty ⇒ zero findings, see ORC‑02) and `verify` lints/tests the pristine template (green), the failure surfaces only at the acceptance-tests gate — after paying for the test-writing session, its fix session and the review skeptics.

**Blast radius.** Wasted spend and, combined with ORC‑02/ORC‑03, a plausible path to delivering an unmodified template with a green gate table.

**Fix.** Call `validateDag(plan.tasks)` in `runJob` right after `ports.plan` and fail closed on an error. Change the `break` at `:208` to record a hard failure (`failed.set('<scheduler>', 'no runnable tasks — DAG is not schedulable')`) instead of falling through, and assert `completed.size + failed.size + blocked.size === plan.tasks.length` before entering `runGates`.

---

## Medium

### ORC-11 — Task clones are never removed; disk grows monotonically for the life of the container

**Location.** [worker.ts:386](../../packages/harness/src/job/worker.ts#L386) is the only call site of `removeWorktree`, and it runs *before* creating a clone, not after finishing one.

Each task gets a full `git clone --no-hardlinks` ([worker.ts:389](../../packages/harness/src/job/worker.ts#L389)) plus hard-linked `node_modules`; anything a worker `npm install`s breaks the links into real copies, and each clone accumulates its own `dist`, `coverage` and Vitest cache. A 12-task L build keeps all twelve. `seedRepo` wipes `<workDir>` only once at start-up ([repo.ts:76-79](../../apps/job/src/repo.ts#L76)). **Fix:** call `removeWorktree(repoDir, task.id)` in `runTask`'s existing `finally` block once `fetchTaskBranch` has brought the branch back (keep it on failure, or archive it into the debug bundle first).

### ORC-12 — `commitAll` ignores git's exit code, and a silent failure makes `restoreProtectedPaths` delete the acceptance tests

**Location.** [gateSessions.ts:88-91](../../packages/harness/src/job/gateSessions.ts#L88)

```ts
const commitAll = async (repoDir: string, message: string, signal: AbortSignal) => {
    await exec('git', ['add', '-A'], { cwd: repoDir, signal })   // exec never throws
    await exec('git', ['commit', '-q', '-m', message], { cwd: repoDir, signal })
}
```

If the commit after the test-writing session fails (a stale `.git/index.lock` left by a killed session — a failure mode the merge path explicitly handles with `rm -f .git/index.lock`), `testsCommit` at `:288` resolves to the *pre-test* commit. `restoreProtectedPaths` then finds the acceptance files absent in that commit and `rm`s them ([gateSessions.ts:166](../../packages/harness/src/job/gateSessions.ts#L166)). It fails closed (the files are "not executed"), but only after paying for the fix session. **Fix:** use `execOrThrow` for `git add`, and throw on a `git commit` failure that is not "nothing to commit" — the same discipline `commitLeftovers` already applies in the worker.

### ORC-13 — `discardChanges` does not clean ignored paths, so a "read-only" session's Bash can leave `node_modules` modified for every later gate

**Location.** [gateSessions.ts:121](../../packages/harness/src/job/gateSessions.ts#L121) — `git clean -qfd`, no `-x`.

`readOnlyTools` includes `Bash` ([worker.ts:568](../../packages/harness/src/job/worker.ts#L568)); the read-only rule is prompt-only, which is precisely why `discardChanges` exists. But `-fd` without `-x` leaves everything in `.gitignore` — `node_modules`, `dist`, `coverage`. `shareWithWorker` makes every directory group-writable, so a worker-uid session can replace `node_modules/.bin/vitest` in `repoDir` (the hard-linked *files* are protected, the directory entries are not, as the doc comment itself notes). Every subsequent gate — `verifyRepo`, `runAcceptanceTests`, `licenceGate`'s `npm ls` — then runs the replacement. **Fix:** verify the integrity of the gate toolchain instead of relying on cleanup — e.g. resolve `vitest`/`eslint` from a job-owned path outside the shared tree, or hash `node_modules/.bin` at seed time and re-check before the gate chain.

### ORC-14 — `pushBranch` ignores the abort signal

**Location.** [github.ts:46](../../packages/harness/src/job/delivery/github.ts#L46)

```ts
const result = await exec('git', args, { cwd: repoDir, timeoutMs: 10 * 60_000, env })
```

No `signal`. A kill or budget breach during delivery cannot cancel the push; the job keeps running for up to ten minutes and completes a push it was told to abandon. `DeliveryInput.signal` is available at the call site. **Fix:** thread `signal` through `GitHubClient.push`.

### ORC-15 — Planner: no criteria-coverage check, a schema far looser than the prompt, and no retry when the model skips the tool

**Location.** [planner.ts:206-227](../../packages/harness/src/job/planner.ts#L206), [Job.ts:63](../../packages/models/schemas/Job.ts#L63)

- `PlanSchema.tasks` is `.min(1).max(40)` while the prompt contracts 2–12. A 40-task plan is accepted; with `maxWorkers` 2–4 and up to 160 turns each, it cannot fit any budget, and nothing pre-flights that.
- The prompt requires every acceptance criterion to be covered by some task's `acceptanceCriteriaIds`; `parsePlan` validates only the DAG. `acceptanceCriteriaIds` are never checked for well-formedness or existence either — `f99.c99` is accepted and rendered verbatim into the worker prompt. A plan that covers 2 of 8 features is built in full and only fails at the acceptance gates, at the end.
- In the retry path, `findToolUse(first)` is called *again* inside the `catch` ([planner.ts:212](../../packages/harness/src/job/planner.ts#L212)). If the first response contained no `tool_use` at all (a `max_tokens` truncation of a 12-task plan at the 16 000-token limit is the realistic trigger), that re-throws and the job fails with no retry, having already paid for the call.

**Fix.** Add a coverage assertion to `parsePlan` (`every criterion id appears in some task; every id in a task exists`), tighten `.max()` to the prompt's contract or reject plans whose worst-case turn budget exceeds `maxTokens`, and restructure the retry so a missing tool call is itself a retryable condition.

### ORC-16 — `ANTHROPIC_API_KEY` is the one credential missing from `apps/job`'s env scrub, contradicting the comment two lines below it

**Location.** [index.ts:41-56](../../apps/job/src/index.ts#L41)

```ts
for (const key of ['JOB_TOKEN','DATABASE_URL','DATABASE_SECRET_ARN',
    'ANTHROPIC_API_KEY_SECRET_ARN','GITHUB_TOKEN','GITHUB_TOKEN_SECRET_ARN']) {
    delete process.env[key]
}
// "The raw Anthropic key is NEVER put in process.env from here on …"
```

`resolveAnthropicKey` reads `process.env.ANTHROPIC_API_KEY` first ([config.ts:87](../../apps/job/src/config.ts#L87)) and never removes it. The key is defended twice more (`sandboxEnv` denies `ANTHROPIC_API_KEY$`; the second uid blocks `/proc/<pid>/environ`), so this is defence-in-depth rather than a live exploit on Fargate — but under `job:dev`/`WORKER_UID` unset it is single-uid, and the comment claims a property the code does not establish. **Fix:** add `'ANTHROPIC_API_KEY'` to the list (the value is already captured in `config.anthropicApiKey` before this point).

### ORC-17 — Every event *and* every status transition failure is silently swallowed

**Location.** [orchestrator.ts:22](../../packages/harness/src/job/orchestrator.ts#L22), [index.ts:206-210](../../apps/job/src/index.ts#L206)

```ts
const emit = (event) => hooks.emit(event).catch(() => {})
```

`apps/job` wires `hooks.emit` as `async event => { await trackPhase(event); await emit(event) }` — so `trackPhase`'s `setStatus` (a real PATCH that can throw after its retries) is inside the swallow. A sustained api outage therefore drops every event *and* every `planning → building → verifying` transition with no log line and no counter, while the job burns the full budget. The `notify` admin mail on failure goes the same way. **Fix:** count consecutive `emit` failures and log/abort past a threshold; at minimum `log.warn` each swallowed failure rather than `catch(() => {})`.

---

## Low

- **ORC-18** — [merge.ts:26-33](../../packages/harness/src/job/merge.ts#L26): `filesWithConflictMarkers` passes raw `git diff --name-only` output to `grep`. With git's default `core.quotepath=true`, a path containing non-ASCII comes back as `"public/locales/sv\303\244.json"`; grep then fails to open it (exit 2, empty stdout) and the marker scan silently skips that file — re-opening the exact hole the check was added to close (M3‑REVIEW #2). Fix: `git -c core.quotepath=false` or `-z`.
- **ORC-19** — [usage.ts:29-33](../../packages/harness/src/job/usage.ts#L29): `if (delta <= 0) return 0` compares *weighted* totals, so a re-sighting whose cache-read bucket shrank while output grew is dropped entirely — the raw buckets never reach `cost()`. Compare per bucket, or gate on `Math.max` of the bucket deltas.
- **ORC-20** — [exec.ts:255-259](../../packages/harness/src/job/exec.ts#L255): the `child.on('error', …)` path neither `clearTimeout(timer)` nor removes the abort listener (only `close` does). On a spawn failure that does not emit `close`, a 15-minute timer keeps a handle alive. Move both into a shared cleanup.
- **ORC-21** — `specService.freeze` is read-then-`upsert`, not compare-and-set (unlike `sendMessage`'s `updateUnlessFrozen`). A message landing between the read and the write is silently discarded and the price is computed from the pre-message spec.
- **ORC-22** — [bundle.ts:119](../../packages/harness/src/job/delivery/bundle.ts#L119): `as unknown as [DeliverableFileName, Uint8Array]` launders `transcripts/<name>` past the `DeliverableFileName` union. Benign at runtime, but it is the one place a type is defeated rather than widened; widen the debug-bundle entry type instead.
- **ORC-23** — [exec.ts:135-137](../../packages/harness/src/job/exec.ts#L135): `applySharedUmask()` mutates the process-global umask on every `exec` and never restores it. Deliberate per the comment, but it means the job process's own later file creation (transcripts, temp bundles) is group-writable too.
- **ORC-24** — [bootArtifact.ts:24](../../packages/harness/src/job/delivery/bootArtifact.ts#L24): the boot verdict is `/Server listening/i` matched against the child's own stdout — a log line the generated app controls. The live path uses `createWiredSmokeCheck` (which actually connects), so this only bites callers of `createNodeBootCheck`; worth asserting a TCP connect regardless.

---

## Test coverage gaps

Named, specific, and in order of what they would have caught above.

1. **`apps/job/src/index.ts` has no test file at all** (`apps/job/test/` = `anthropicForwardProxy`, `config`, `repo`, `reporter`). Untested branches: the `SIGTERM` and `unhandledRejection` handlers; exit codes 0/1/2/3/4; the `status !== 'queued'` refusal; the killed-preservation on the terminal `setStatus` (`final.killed ? 'killed' : final.status`); the debug-bundle branch (`outcome.status !== 'delivered' && artifacts.kind === 's3'`); and the fact that `reporter.load()` runs *before* the handlers are registered. Every claim in M3‑REVIEW #6/#8 about crash handling is unverified by any test.
2. **No test asserts `THIRD-PARTY-LICENCES.md` survives to delivery.** `licence.test.ts` asserts it is written to disk; `deliver.test.ts` (19 cases) never checks the committed tree for it. ORC‑01 lives exactly in that seam.
3. **`BudgetTracker` has 3 tests, all in [budget.test.ts](../../packages/harness/test/job/budget.test.ts).** Untested: `pauseClock`/`resumeClock` accounting (the mechanism that can disable `maxDurationMinutes` indefinitely — the orchestrator-level "does not charge the approval wait" test exercises it only end-to-end); per-model attribution in `add(usage, model)` and the `unknownModel` fallback; `adjust()` crossing the cap; the first-breach idempotence of `abort()` under concurrent `add` calls.
4. **No test for a vacuous full-repo gate.** `worker.test.ts` covers "Is red when the scoped vitest run collected nothing but the workspace has test files" — the *scoped* branch only. There is no case for a root `npm test` that collects nothing, a workspace removed from `vitest.config.ts` `projects`, or a deleted `lint` script under `--if-present` (ORC‑03).
5. **`reviewGate`'s medium branch is unpinned.** `gateSessions.test.ts` has "Fails when a high finding is still open after the fix" but nothing for a *medium* still open after the fix (sweep‑4 #3), and nothing asserting what the fix session may or may not touch — the review path has no equivalent of "Restores the vitest config, package.json scripts and setup files the fix touched".
6. **Licence gate: `missing` is never asserted for policy.** No case where a package npm reports as not installed carries a denied licence (ORC‑06). The existing cases only check the summary wording.
7. **`exec`: no output-volume test.** `exec.test.ts` (19 cases) covers process groups, launch command lines, timeouts and refused kills, but nothing about output size — no cap exists to test.
8. **DAG-vs-orchestrator seam.** `dag.test.ts` covers cycles/duplicates/unknown deps in isolation; `orchestrator.test.ts` never feeds `runJob` a cyclic or unschedulable plan, so the `break` at `orchestrator.ts:208` falling through to the gates (ORC‑10) is unexercised.
9. **Merge: the two known post-commit failure paths are untested.** No case for `syncDependencies` failing *after* the merge commit is already on `main`, and none for a dirty `main` (uncommitted `package-lock.json`) causing the next `git merge` to refuse.
10. **Spec engine: no cost/length bound test.** `specEngine.test.ts` drives one question→answer→complete cycle; nothing covers a long conversation, a message-count cap (there is none) or the context-overflow 400 that permanently bricks a draft.
11. **`seedCommit` handling is untested end to end.** `reviewGate` has "Defaults the diff base to the root commit" (covers `undefined`) but no case for `''` — the failure in ORC‑02.
12. **Mocked-away thing under test.** `merge.test.ts` mocks `runSession` via `vi.mock('#job/worker.ts')` — correct for isolating git behaviour, but it means the *repair prompt's* actual instruction ("do NOT run `git add`") is never exercised against a session that disobeys, which is the historical failure mode. `runTask.test.ts` injects `ports.runSession`/`ports.verifyRepo` fakes, so `createWorktree`/`commitLeftovers`/`fetchTaskBranch` — the parts that broke on four separate Fargate runs — are covered only by the narrower `worker.test.ts` cases.

---

## Docs-vs-code drift

- **`docs/M3-REVIEW.md` #12 "deferred" is stale.** It says non-local connections use `ssl: 'require'`; PLAN.md M9 records `verify-full` shipped 2026-08-27. The M3‑REVIEW status column was never updated. Cosmetic, but the file is the reference reviewers read first.
- **Sweep‑4 (`docs/backlog/hardening-2026-08-30/4-orchestrator-correctness.md`) is `0/30 fixed` per the due-diligence doc, and the code confirms it.** Re-verified as still present, verbatim: clean merges accepted on git's exit code ([merge.ts:85](../../packages/harness/src/job/merge.ts#L85)); `syncDependencies` leaving the lock uncommitted and the merge commit in place on install failure ([merge.ts:177](../../packages/harness/src/job/merge.ts#L177), [merge.ts:183](../../packages/harness/src/job/merge.ts#L183)); no `reset --hard`/`clean -fd` between serialized merges ([merge.ts:79](../../packages/harness/src/job/merge.ts#L79)); `openHigh` re-blocking only `high` ([gateSessions.ts:690](../../packages/harness/src/job/gateSessions.ts#L690)); gate fix sessions discarded on turn cap without re-verifying ([gateSessions.ts:308](../../packages/harness/src/job/gateSessions.ts#L308), [:646](../../packages/harness/src/job/gateSessions.ts#L646)) while the worker deliberately does the opposite ([worker.ts:1075](../../packages/harness/src/job/worker.ts#L1075)); no `failed.size` short-circuit in the scheduler ([orchestrator.ts:196](../../packages/harness/src/job/orchestrator.ts#L196)). Not re-reported above.
- **The approval park is worse than sweep‑4 #6 describes.** `waitForApproval` ([orchestrator.ts:38-45](../../packages/harness/src/job/orchestrator.ts#L38)) loops on `hooks.isApproved` — if the hook is *absent* while `approveBeforeDeliver` is true, the loop never terminates, and because `budget.pauseClock()` was called first, `checkDuration` can never trip. Only the kill switch escapes. `apps/job` always supplies the hook, so this is a library-contract hazard, not a live one — but the tests (`orchestratorDelivery.test.ts`, 5 hold cases) do not cover the absent-hook path.
- **`docs/EFFICIENCY.md` claims `cache_read_input_tokens > 0` is "assumed, not verified".** Still true — nothing in the code asserts caching is on, and `sessionEnv`'s `DISABLE_PROMPT_CACHING*` strip is tested but its *effect* is not observable anywhere. The `task efficiency` log line reports `usage.cacheReadInputTokens`, so the check is one grep away from being automatable; consider a warning when a session's second turn reports zero cache reads.
- **`apps/job/src/index.ts:51-56` comment overstates the env scrub** — see ORC‑16.
- **`merge.ts:71-74` docstring** says "if anything is still conflicted the merge is aborted and the job fails closed (a half-merged main is worse than a failed job)". True for conflicts, but `syncDependencies`'s install-failure return at `:183` leaves the merge commit on `main` while reporting the task failed — the one path that contradicts the stated invariant (sweep‑4, known).
- **`PLAN.md` M4 records the licence gate as LIVE-VERIFIED 2026-08-30.** The *gate* ran; the artifact it exists to produce did not reach the delivery (ORC‑01). Worth amending the claim.

---

## Verified-good

Things I specifically tried to break and could not:

- **Per-model usage attribution is correct.** I expected `runTask`'s `count` (which calls `onUsage(usage)` with no model) to bill every worker token to `unknown` — but [ports.ts:22](../../packages/harness/src/job/ports.ts#L22)'s `tagged()` wrapper (`(usage, reported) => input.onUsage(usage, reported ?? model)`) fills the model in at the port boundary for planner, worker, merge, all three model gates and delivery. `cost()`/`jobs.usage` are sound.
- **`runGates` fails closed on every axis** ([gates.ts:78-86](../../packages/harness/src/job/gates.ts#L78)): a thrown port becomes a red report with its tokens preserved; the chain stops at the first red; an abort produces no report for the interrupted gate and `ok: !isAborted()`. `gatePort` is exhaustive over `GateName` with no default branch, so a new gate is a compile error rather than a silent skip.
- **`tallyRefutations` abstains toward keeping** ([review.ts:64-72](../../packages/harness/src/job/gates/review.ts#L64)): a skeptic session that fails returns `[]` and `skeptics` is passed explicitly, so a failed skeptic is an abstention and cannot shrink the majority into dropping a real finding. `isFalsePositive` requires a *strict* majority. Correctly tested ("Keeps findings (fails closed) when every skeptic session fails to rule").
- **`citationExists`** ([review.ts:105-116](../../packages/harness/src/job/gates/review.ts#L105)) rejects absolute paths and resolves-then-prefix-checks against the repo root, so `../../etc/passwd` cannot make a hallucinated finding "exist".
- **`evaluateVitestReport`** ([worker.ts:513-540](../../packages/harness/src/job/worker.ts#L513)) is genuinely non-vacuous: a file that was not executed, a file with zero assertions, and any non-`passed` status are all red. This is the single strongest anti-cheat in the pipeline and the reason ORC‑03 is bounded rather than total.
- **`sandboxEnv`'s git stripping is complete for the incident it was written for** ([exec.ts:59-61](../../packages/harness/src/job/exec.ts#L59)): `GIT_DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX|NAMESPACE|CEILING_DIRECTORIES`, applied inside `exec` itself (not at call sites), so every `spawn` in the harness gets it — including `createWorkerSpawner` (via `sessionEnv`) and `bootArtifact`. `noHooksEnv` is spread *after* the inherited env with `GIT_CONFIG_COUNT=2`, so an inherited `GIT_CONFIG_KEY_2` is unreachable. The only gap I found is `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`/`GIT_EXEC_PATH`, which cannot redirect the repository and are unreachable from the sandbox — not worth a finding.
- **`ApiReporter`'s ordering and idempotence** ([reporter.ts:130-140](../../apps/job/src/reporter.ts#L130)): the `queue.then(task, task)` chain never poisons itself, events carry a monotonic `seq` so a retry after a lost response is deduped server-side, 4xx is final while 5xx/transport errors back off exponentially, `claim` deliberately does not retry (a rotated bootstrap token can never re-authenticate), and 401 on the polls is read as killed / not-approved. Well covered by 15 tests.
- **`abort` plumbing reaches every model call.** `budget.controller.signal` flows into `planner.call` as a request option ([planner.ts:167](../../packages/harness/src/job/planner.ts#L167)), into `runSession` via a forwarded `AbortController` with the listener removed in `finally` ([worker.ts:715-719](../../packages/harness/src/job/worker.ts#L715)), into every `exec` (`spawn({ signal })` + an explicit `killProcessGroup` on abort), and into both AWS pollers via `defaultSleep`. The one hole is `pushBranch` (ORC‑14).
- **`git merge --abort` / cleanup calls deliberately omit the signal** ([merge.ts:89](../../packages/harness/src/job/merge.ts#L89), `:126`, `:152`) so an abort cannot prevent the repo from being restored. That is the right call and easy to get wrong.
- **`redactUrlCredentials` + `buildPushInvocation`** keep the GitHub installation token out of both argv and error text, with three tests pinning it.
- **`licenceDenialOf`'s SPDX evaluator** ([licence.ts:83-127](../../packages/harness/src/job/gates/licence.ts#L83)) is a real recursive-descent parser with `OR`/`AND`/parens/`WITH` semantics and denies anything malformed — genuinely fail-closed for everything it actually inspects (which is the point of ORC‑06: the input set, not the evaluator, is the hole).
- **`protectGitDir` / `shareWithWorker`'s hard-link rule** (`-links 1` on the chmod selector) correctly keeps the shared template `node_modules` inodes read-only across worktrees, and the main repo's `.git` out of the worker's reach. The rationale comments name the specific Fargate runs that motivated each rule — this is the best-documented part of the codebase.