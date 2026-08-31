# Code audit — 31 August 2026

An adversarial **code-level** audit of `main` at `8574129`. Companion to
[docs/DUE-DILIGENCE-2026-08-31.md](DUE-DILIGENCE-2026-08-31.md), which asks *how much of the plan
is real*; this one asks *does the code that exists do what it claims*. Five parallel review
streams (security/api, orchestrator, infra/CI, backend/data, frontend/docs) reading the source,
plus independent re-verification of every P0 below against the files themselves.

Baseline on the audited commit: `npm run lint` clean, `npm test` **1175 passed / 3 skipped, 152
files**. Nothing here is a lint or type error — the build is green and the bugs are underneath it.

Full stream reports: [docs/audit/](audit/). Those are working files; delete the folder when this
list is burned down.

**How to use this.** Work P0 top to bottom, one PR per finding, in a worktree. Each P0 carries a
`Verify:` line — the check that must go from red to green. Do not tick anything without it.

---

## Verdict

The architecture is sound and the discipline is visible — abort plumbing, fail-closed gate
chaining, org scoping, per-job token rotation, SPDX parsing and the sandbox uid work are all
better than they need to be, and the rationale comments naming the specific Fargate run that
motivated each rule are genuinely excellent. The problems are not in the design; they are in
seams. Four of the six P0s are **one-line defects sitting between two correct components**: a
scoped IAM grant negated by an unscoped one two lines later, a `??` that does not catch `''`, a
gate that writes a file the next gate deletes, a guard that lives in the shell script CI does not
call.

What makes them dangerous is that every one of them is **silent**. The licence manifest, the
review gate and the `awaiting_approval` transition all fail without a red gate, a failed test or a
log line — three of them fail *after* a paid build has been spent. The single systemic cause is
that the entire API test suite runs against the in-memory repository implementation, so **no test
in this repo has ever executed a real SQL statement**; that is why a CHECK constraint has been
missing a required enum value since migration 0004 with 1175 tests green over the top of it.

The other theme is trust placement: the QA gates shell out to the customer repo's own
`npm run lint` / `npm test`, and nothing pins what those cover — so the thing being gated can
shrink the gate. Combined with the review-gate bug (ORC-02) there is a plausible, fully green path
to delivering an essentially unmodified template.

None of this is a rewrite. It is roughly a week of small, surgical PRs.

---

## P0 — fix before a paying customer

### P0-1 · Cross-tenant deliverable exfiltration via the delivery CodeBuild role
`infra/lib/resources-stack.ts:376-378` — *verified directly*

```ts
this.artifactsBucket.grantRead(this.deliveryBuildProject, 'delivery-source/*')  // :376 scoped
this.deliverablesRepository.grantPullPush(this.deliveryBuildProject)
this.artifactsBucket.grantRead(this.deliveryBuildProject)                       // :378 UNSCOPED
```

Line 378 grants the delivery build project read on the **whole** artifacts bucket, silently
negating the scoped grant two lines above. That bucket holds `deliverables/<jobId>/repo.zip` for
every customer.

The reachable path: AI-generated code in the job container holds the ECS task role → the task role
has `codebuild:StartBuild` on `mf-delivery-build-<env>` (`resources-stack.ts:504`) → `StartBuild`
accepts `buildspecOverride` and **there is no IAM condition key that can restrict it**, so it is
arbitrary command execution as the CodeBuild service role → that build runs `privileged: true`
(`:355`) on the CodeBuild-managed network, outside the job security group, so `HTTP_PROXY`,
tinyproxy and the SG egress rules do not apply → read every other customer's repo zip and post it
anywhere.

This defeats the egress allowlist by routing around it rather than through it. Identical in dev,
qa and live.

**Fix:** delete line 378 (the scoped grant already covers what the buildspec reads). Then, as
follow-ups: move delivery source to its own bucket, and give the project a `vpcConfig` so builds
sit behind the same egress controls.
**Verify:** `cd infra && npx cdk synth` → `DeliveryBuildProjectRoleDefaultPolicy` no longer lists
the bare bucket ARN alongside `/*`; add an `infra/test` assertion that the only S3 resource on
that role is the `delivery-source/*` prefix.

### P0-2 · `awaiting_approval` is not in the `orders` CHECK constraint
`packages/db/migrations/0004_orders_users_auth.sql:21-25` vs `apps/api/src/services/orderService.ts:128` — *verified directly*

```sql
-- 0004, the last migration to touch orders_status_check
status in ('drafting','ready','frozen','deposit_paid','building','delivered','paid','cancelled')
```
```ts
// orderService.ts:128
const next: OrderStatus = order.approveBeforeDeliver ? 'awaiting_approval' : 'delivered'
```

`awaiting_approval` is in `orderStatus` (`packages/models/schemas/Order.ts:20`), in the transition
map (`:45-46`), in the route (`approveOrder.ts`), and in migration 0012's *comment* — but no
migration ever adds it to the constraint. On real Postgres, any order with
`approveBeforeDeliver = true` throws `23514 check_violation` the moment the build finishes: the
build is paid for, complete, and the order cannot be moved out of `building`.

It is green in CI because every api test uses the in-memory repositories (see T1 below).

**Fix:** a forward-only migration dropping and re-adding `orders_status_check` with the full
`orderStatus` list. While there: derive the SQL list from `@mf/models` in a test so the two cannot
drift again.
**Verify:** a `packages/db` test against real Postgres (`docker compose up -d`) that walks
`building → awaiting_approval → delivered`. Today no such test can exist — see T1.

### P0-3 · The licence manifest is deleted before delivery can commit it
`packages/harness/src/job/gates/licence.ts:386` → `gateSessions.ts:121` — *verified directly*

The licence gate writes `THIRD-PARTY-LICENCES.md` into the working tree as an **untracked** file
(it is not in `templates/web`), relying on delivery to commit it. Gate order is
`verify → acceptance-tests → review → licence → acceptance-check`, and `acceptanceCheckGate`'s
mandatory cleanup runs `git clean -qfd`, which deletes exactly that file. `deliver()`'s
`commitDocs` then finds nothing.

So every delivered repo, every `repo.zip` and every bundle ships **without** the file, while
`delivery/docs.ts:128` tells the customer "Every installed package … is listed in
`THIRD-PARTY-LICENCES.md`" and the handover gate table shows `licence: ok`. `kundavtal §9.2` is
the reason the gate exists. Completely silent — no gate, test or log notices.

**Fix:** commit the file inside the licence gate rather than deferring to delivery.
**Verify:** a `deliver.test.ts` case asserting `THIRD-PARTY-LICENCES.md` is present in the
committed tree — the 19 existing delivery cases never look.

### P0-4 · An empty `seedCommit` turns the review gate into a green no-op
`apps/job/src/index.ts:167` → `packages/harness/src/job/gateSessions.ts:594` — *verified directly*

```ts
const seedCommit = (await exec('git', ['rev-parse','HEAD'], { cwd: repoDir })).stdout.trim()  // exec never throws
const seed = input.seedCommit ?? (await rootCommit(repoDir, signal))                          // ?? misses ''
```

`exec` returns `code: -1, stdout: ''` instead of throwing. `''` is not `undefined`, so the
`rootCommit` fallback never fires and the diff range becomes `'..HEAD'`, which git resolves to an
**empty diff**. The reviewer is asked to review nothing, correctly returns zero findings, the
skeptic pass is skipped, and the gate reports `ok: true` — "0 finding(s), none high/medium open".
The build ships with the security/correctness gate structurally bypassed and every report saying
it passed.

**Fix:** `input.seedCommit || (await rootCommit(...))`, plus an explicit throw in `apps/job` when
`rev-parse` yields nothing. Additionally treat an empty `git diff --name-only` over the range as a
**red** gate — "nothing to review" is never a legitimate green after a build.
**Verify:** a `gateSessions.test.ts` case passing `seedCommit: ''`; today only `undefined` is
covered.

### P0-5 · A `live` deploy through CI publishes a plain-HTTP API
`infra/lib/web-stack.ts:156-164`, `infra/lib/config.ts` (live block), `infra/scripts/deploy.sh:23`, `.github/workflows/deploy-environment.yml:73-85` — *verified directly*

```ts
...(domain && { protocol: ApplicationProtocol.HTTPS, redirectHTTP: true, certificate: … })
```

`live` has no `domain` block, so the ALB listener falls back to plain HTTP: a public API over
cleartext, build jobs reporting over cleartext, and — per the guard's own comment — no SES
identity, so magic-link sign-in fails and the sole admin can never sign in to a "successful" live.

The guard for this exists (`deploy.sh:23` → `scripts/check-live-domain.ts`), but
`deploy-environment.yml` runs `npx cdk deploy …` **directly**, so the automated path — the one
that actually fires on push to `main` — skips it entirely. A guard in the wrong layer.

**Fix:** move the check into the CDK app (`infra/bin/app.ts`), so it fails at synth for every
caller. Keep the `deploy.sh` call as a fast pre-flight.
**Verify:** `MF_ENV=live npx cdk synth` fails until `live.domain` is configured; add an
`infra/test` case asserting no environment can synthesise an HTTP api listener.

### P0-6 · Access **and** 30-day refresh tokens in `localStorage`
`apps/portal/src/features/session/sessionListeners.ts:15-16`, `sessionSlice.ts:13-14` — *verified directly*

```ts
localStorage.setItem('token', token)
localStorage.setItem('refreshToken', refreshToken)
```

Any XSS in the portal — including one introduced by a future generated component — yields a
30-day refresh token, i.e. durable account takeover that survives password-less re-auth and is
invisible to the user. The API has no CSP and no `@fastify/helmet` to reduce the blast radius, and
`cors` is `origin: '*'` (`apps/api/src/server.ts:60`).

**Fix:** refresh token to an `httpOnly; Secure; SameSite=Strict` cookie scoped to
`/bff/auth/refresh`; keep the 1-hour access token in memory only and re-acquire it on load. Add
`@fastify/helmet` and replace the wildcard CORS with the site/portal origins per env.
**Verify:** a portal test asserting `localStorage` holds no `refreshToken`; an api test asserting
the refresh cookie flags.

---

## P1 — before the next paid dogfood run

| # | Finding | Location |
|---|---------|----------|
| P1-1 | **The gate is the repo's own `npm test`, and nothing pins its scope.** Deleting a workspace `lint` script (`--if-present` skips silently), removing a workspace from the root `vitest projects`, or rewriting the root `test` script all make a red repo green. `restoreProtectedPaths` exists but is called from exactly one place; 12 task workers, the merge repair and the review fix session are all free to edit those files. | `packages/harness/src/job/worker.ts:474-487`, `gateSessions.ts:311` |
| P1-2 | **Unbounded Anthropic spend per order.** The spec chat caps message *size* (8 000 chars) but not message *count*, and resends the whole conversation each turn — cost grows quadratically. No rate limit on the one endpoint that spends real tokens. Past the context window it 400s forever and the draft is permanently unusable with no reset path. | `apps/api/src/services/specService.ts`, `packages/harness/src/spec/specEngine.ts:150` |
| P1-3 | **Magic-link email bombing.** The limit is 3 per *address* per 10 min with no global cap and no IP cap — unlike `contactRateLimit`, which has `globalMax: 60`. Unlimited distinct addresses ⇒ unlimited outbound mail from our SES identity, i.e. reputation loss and possible suspension. | `apps/api/src/services/authService.ts:56,97` |
| P1-4 | **Licence gate is fail-open for every package npm did not install.** `missing` entries are listed in prose and never evaluated against the denylist. The live dev run reported "57 not installed here" and stayed green; those packages are pinned in the delivered lockfile and *will* install for the customer. | `packages/harness/src/job/gates/licence.ts:273-279` |
| P1-5 | **A delivery failure after the push orphans a billing ECS service.** `deployedService` is only surfaced inside the `Deliverable` built in the *bundle* step; if `uploadBundle` throws, the repo is pushed, an Express service is ACTIVE and billing, and nothing — portal, deliverable, registry — records that it exists. | `packages/harness/src/job/delivery/deliver.ts:224,254,281` |
| P1-6 | **The portal can never render Swedish.** `i18n.init` sets `supportedLngs: ['en','sv']` and `fallbackLng: 'en'` but no `lng` and no language detector (`apps/site` correctly sets `lng` from the path). The sv locale file exists and passes the parity test while being unreachable. PLAN.md open question 5 answered "Swedish too definitely". | `apps/portal/src/app/i18n.ts:13-15` |
| P1-7 | **Concurrent gate reports are lost.** `reportEvents` read-modify-writes `jobs.gates` with no CAS or transaction. | `apps/api/src/services/jobService.ts` |
| P1-8 | **Every security gate in CI is `continue-on-error: true`**, so `npm audit` and Trivy cannot fail a merge. `ci.yml` also has no `permissions:` block. | `.github/workflows/ci.yml:135+` |
| P1-9 | **No timeouts on any AWS SDK client or the Anthropic client** (Stripe and GitHub do it right); no statement/idle/connect timeout on the Postgres pool; migrations run at api boot in one transaction with non-concurrent index builds. | `apps/api/src/plugins/*.ts`, `packages/db/src` |
| P1-10 | **Portal polling never stops** on terminal jobs (`latestActive` comes from a query that is never refetched), and `killJob` invalidates no tags, so order, list and events all stay stale after a kill. | `apps/portal/src/features/**` |
| P1-11 | **`runJob` treats "no task can run" as "build finished".** A cyclic or unschedulable plan yields zero ready tasks, `failed.size === 0`, and the job proceeds through the full gate chain — and delivery — on a repo where no task ever ran. `validateDag` is never called on the plan `runJob` is handed. | `packages/harness/src/job/orchestrator.ts:196-215` |
| P1-12 | **Uncapped child-process output + no `uncaughtException` handler.** `exec` accumulates stdout into an unbounded string; model-written test code can OOM the container or throw `RangeError` inside a stream listener, which neither handler catches — so the job dies with no terminal status write, after the full budget is spent. | `packages/harness/src/job/exec.ts:249-250`, `apps/job/src/index.ts:152-153` |

---

## P2 — carry into the backlog

Detail in [docs/audit/](audit/). Highest value first:

- **Data layer** (`audit/BACKEND.md`): 11 named missing indexes (incl. the liveness sweep's
  seq-scan on `jobs`, `rate_limits(hit_at)`, `magic_links(expires_at)`), 3 FKs dropped for a
  uuid→text widening and never restored, `resident_usage.billable_usd` as `double precision`
  feeding a Stripe meter, 4 list queries that silently truncate, generated app secrets stored
  plaintext in `deployed_services.config`.
- **Infra** (`audit/INFRA.md`): api container runs as root; tinyproxy runs as root on `0.0.0.0`
  allowing the whole RFC1918 space; `ecs:TagResource` on `*`; no CloudFront/ALB/VPC flow logs;
  `.dockerignore` does not exclude `.env` or `*.pem`; `eval` of grepped `.env` content and
  `export VAR=$(cmd)` defeating `set -e` in `deploy.sh`; SPA buckets without `enforceSSL`.
- **Orchestrator** (`audit/ORCHESTRATOR.md`): task clones never removed (disk grows monotonically
  across a 12-task build); `commitAll` ignores git's exit code, which can make
  `restoreProtectedPaths` delete the acceptance tests; the review-fix session may mutate anything
  with no acceptance re-check; `pushBranch` ignores the abort signal; planner accepts up to 40
  tasks against a prompt contracting 2–12 and never checks criteria coverage; the size class is a
  negation-blind keyword match that sets price, budget *and* turn caps and is never re-validated
  against the plan.
- **Frontend** (`audit/FRONTEND.md`): no error boundary in either SPA despite Sentry being wired;
  no route-level code splitting (admin ships to every customer); markdown pipeline escapes raw
  HTML but not `javascript:` URLs; several RTK Query mutations under-invalidate.
- **Docs** (`audit/DOCS.md`): 10 contradictions, incl. three documents giving three answers on
  whether the `mjukvaruhuset` GitHub org exists (this blocks all delivery), PLAN.md contradicting
  itself on GitHub sign-in ~90 lines apart, and the public site selling 15/45/120k SEK while
  PLAN.md sets a 5 000 SEK ceiling.

---

## Cross-cutting themes

These are the causes; the findings above are symptoms. Fixing a theme is worth more than fixing
any single P0.

**T1 · No test has ever executed real SQL.** Every api service and route test runs on
`createMemoryRepositories`. The in-memory implementation has no CHECK constraints, no foreign
keys, no unique indexes and no transactions — so it cannot reproduce P0-2, and it did not. There
are no `packages/db` suites for `orders`, `users`, `auth` or `deployedServices` at all.
*Action:* a `docker compose`-backed integration suite that runs the real migrations and exercises
each repository's write paths, in CI as its own job. This is the single highest-leverage change in
this document.

**T2 · Guards placed in the wrong layer.** P0-1 (scoped grant negated two lines later), P0-4 (`??`
where `||` was needed), P0-5 (guard in the shell script CI does not call), P1-8 (gates that cannot
fail a merge). In each case the *check exists*; it just isn't on the path that matters.
*Action:* when adding a guard, ask which caller bypasses it — and put it at the narrowest point
every caller must pass through (synth, not the deploy script; the gate, not the delivery step).

**T3 · Gates trust artifacts the gated thing can edit.** P1-1 and P0-3 are the same shape: the
harness hands the customer repo authority over its own verification. `evaluateVitestReport` is the
one place that genuinely resists this and is why P1-1 is bounded rather than total.
*Action:* snapshot the gate contract at `seedCommit` (workspaces with a lint script, root test
script, vitest `projects`) and fail closed when coverage shrinks.

**T4 · Documentation is append-only.** Nothing is ever retracted, so PLAN.md, README.md and
TODO-EXTERNAL.md each hold a different generation of the same fact, all in the present tense.
*Action:* when a decision is superseded, delete the old sentence rather than adding the new one
below it. `docs/audit/DOCS.md` proposes a concrete split (README ≤80 lines, PLAN ≤100, decisions
into their own file).

**T5 · `[x]` does not mean what PLAN.md says it means.** The legend is "checkbox = done and
verified"; roughly eight boxes are ticked with "live run pending" written inside the same bullet,
and M5's "Deployed with URL" says LIVE-VERIFIED *and* "live deploy pending" in one entry. M12 and
part of M8 are the opposite — built but marked not started.
*Action:* adopt the due-diligence doc's LIVE / CODE / PARTIAL levels in PLAN.md itself, so the
checkbox stops carrying a meaning it cannot hold.

---

## Suggested sequencing

One PR per item, each with its `Verify:` check.

1. **Day 1 — the one-liners with the worst blast radius.** P0-1, P0-4, P0-3, P0-5. Four small
   diffs, four new tests. P0-1 is a single deleted line.
2. **Day 2 — the data layer.** T1 first (real-Postgres integration suite), then P0-2 on top of it,
   then the missing indexes and the dropped FKs. Doing T1 first means P0-2 arrives with a test
   that would have caught it.
3. **Day 3 — money and spend.** P1-2, P1-3, P1-4, P1-5, P1-12. These are the ones that cost real
   USD or real reputation, and they are independent of each other.
4. **Day 4 — the gate contract.** P1-1 and P1-11, plus T3. Highest design content; worth doing
   after the cheap wins so the pipeline is otherwise quiet.
5. **Day 5 — product surface.** P0-6, P1-6, P1-10, P1-8, P1-9.
6. **Then** the P2 backlog and the T4/T5 documentation pass.

---

## What is genuinely solid

Stated plainly, because a list of defects is not a picture of the codebase.

- **Authorization is correct and consistent.** Every `/bff` route is covered by the `onRequest`
  hook; every admin route carries `job:admin`; `job:admin` is admin-only; org scoping goes through
  a single `scoped()` helper that returns `EntityNotFound` (404, not 403) so cross-org probes
  cannot enumerate. I tried to find an unguarded route and could not.
- **No SQL injection anywhere.** `packages/db` is uniformly porsager tagged templates; even the
  conditional `where` fragments compose through `sql``` rather than string concatenation.
- **Secrets handling is careful.** Job tokens are stored as hashes and looked up by hash; the
  GitHub push token is kept out of argv and error text with three tests pinning it; OAuth `state`
  uses `timingSafeEqual`; magic links are 32 random bytes, hashed at rest, single-use, atomically
  consumed; refresh tokens rotate and are revoked on presentation regardless of validity.
- **`runGates` fails closed on every axis**, and `gatePort` is exhaustive over `GateName` with no
  default branch, so adding a gate is a compile error rather than a silent skip.
- **The review gate's skeptic pass abstains toward keeping findings** — a failed skeptic cannot
  shrink the majority into dropping a real one — and `citationExists` resolves-then-prefix-checks
  against the repo root, so a hallucinated finding cannot cite `../../etc/passwd`.
- **`sandboxEnv`'s git stripping is complete** for the incident that motivated it, and is applied
  inside `exec` itself rather than at call sites, so every child process in the harness inherits
  it.
- **`ApiReporter`** is the best-engineered component in the repo: monotonic `seq` for server-side
  dedupe, 4xx final vs 5xx backoff, a claim that deliberately never retries, and 15 tests.
- The rationale comments that name the specific Fargate run behind each sandbox rule are the
  single best documentation practice in this project and should be kept.
