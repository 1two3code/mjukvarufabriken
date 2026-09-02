# Harness learned log

Every defect a build job surfaces — dogfood or customer, failed run or salvaged one — gets one
entry here. This is the ratchet that turns run failures into permanent harness improvements: an
entry is **open** until its fix *graduates* into one of the three homes that actually change agent
behaviour on future jobs, then it records where it landed.

**Graduation targets** (pick the strongest that fits):
1. **Gate** — a deterministic check in `packages/harness/src/job/gates/` (best: doesn't rely on any
   agent remembering anything). Example: the boot-the-artifact acceptance gate.
2. **Prompt** — worker/planner/gate-session conventions in `packages/harness/src/job/worker.ts` /
   `planner.ts` (weakest home; use when a check can't be deterministic).
3. **Template** — `templates/web`: lint rule, docs the worker reads, or a structural fix so the
   mistake is impossible. Example: `apps/api/Dockerfile --ignore-scripts`.

Sandbox/infra fixes (a fourth, implicit home) count too when the defect was environmental, not
agent behaviour.

**Protocol — after every job run** (the session that ran or babysat it):
1. Append one entry per defect below, newest first. Include job id, phase, symptom, root cause.
2. If the fix landed in the same session, record the graduation target + commit/PR. Otherwise mark
   it **OPEN** — open entries are work items; sweep them before starting the next paid run.
3. Cross-check: would an existing gate/prompt line have caught it? If a *prompt* line failed to
   prevent it, consider promoting to a *gate* — prompts drift, gates don't.
4. TOKENS.md keeps the cost ledger; this file keeps the defect ledger. Don't duplicate numbers
   here — link the run.

Entry format:

```
## YYYY-MM-DD — <job id / run name> (<app/spec>, <size>)
- **Phase:** plan | worker | gate | merge | repair | delivery | deploy | ops
- **Symptom:** what was observed
- **Root cause:** what was actually wrong
- **Graduated to:** gate | prompt | template | sandbox/infra | OPEN — <where, commit/PR>
```

---

## Seed — lessons already earned before this log existed (2026-08-26 → 2026-08-30)

Collected from PLAN.md (M3/M5 boxes), docs/backlog/wave7.md (delivery salvage), docs/EFFICIENCY.md
and the 2026-08-30 incident. Recorded compactly; the source docs hold the detail.

### 2026-08-30 — harness e2e + pre-push hook incident (factory repo, not a job defect)
- **Phase:** ops
- **Symptom:** a harness e2e test's throwaway seed commits landed on the real `main` and got pushed.
- **Root cause:** child `git` processes inherited `GIT_DIR`/`GIT_WORK_TREE` from a running pre-push
  hook, redirecting commits onto the repo the hook was guarding.
- **Graduated to:** sandbox (`exec.ts` `sandboxEnv` strips git repo-location env from every child) +
  infra (branch protection on `main`). Second layer deliberate: a similar bug elsewhere can't
  repeat silently.

### 2026-08-28 — first live delivery salvage (family-hub, delivery/deploy phase; wave7.md "salvage")
- **In-process green ≠ the artifact boots** — the overarching lesson. Tests/review/acceptance all
  passed in-process while the built container crashlooped.
  **Graduated to:** gate (boot-the-artifact acceptance gate + wired smoke: `bootArtifact.ts`,
  `wiredSmoke.ts`).
- CJS/ESM interop: named ESM imports of CJS-only deps pass vitest (esbuild wraps interop) but crash
  Node's type-stripping runtime. **Graduated to:** gate (boot catches it); prompt/template halves
  (lint rule, documented runtime constraints) — **OPEN**, still worth landing.
- Missing env at boot: the app needed secrets nobody generated. **Graduated to:** gate/delivery
  (env-manifest step detects + generates required secrets).
- No container logs → crash invisible, root-caused from exit codes. **Graduated to:** infra
  (always-on `awsLogsConfiguration` for Express services).
- Root `prepare=husky` broke every customer image build. **Graduated to:** template
  (`apps/api/Dockerfile` `--ignore-scripts`).

### 2026-08-27 — job 9c6f86ac stuck `queued` forever
- **Phase:** ops
- **Symptom:** Fargate task died before claiming its report token; job never left `queued`.
- **Root cause:** no liveness reconciliation between ECS task state and the job row.
- **Graduated to:** infra (M9 `jobSweep`: periodic `ecs:DescribeTasks`, marks `failed` with exit
  reason).

### 2026-08-26/27 — live runs #5–#12 (S demo spec), one real defect each
All environmental/sandbox, all fixed same-wave (PLAN.md M3): budget sized too small, deps sync
after merge, husky hooks firing in worktrees, root uid, empty-JSON token claim (400), SDK
max-turns surfacing as a thrown error, setpriv caps breaking fetch, worker uid on npm install,
repair-session staging. **Graduated to:** sandbox/orchestrator fixes in
`packages/harness/src/job/` + `apps/job`.

### 2026-08-27/28 — token efficiency (docs/EFFICIENCY.md)
- Turns dominated by whole-monorepo lint/test waits; gate ran unscoped; caches unverified.
- **Graduated to:** prompt/orchestrator (diff-scoped task gates, size-based turn caps with cap
  hits recorded on task events, gate-at-most-twice, `foundationTurns` 120→160, per-task
  efficiency log line). **OPEN:** wave-3 savings are still estimates — the next dogfood run must
  re-measure against the 2026-08-26 baseline before the numbers are trusted (PLAN.md M10).

---

<!-- New entries above the seed section, newest first. -->

## 2026-09-02 — job 4922e82d (Ögonblick, redeliver of run 7, 2nd) — "delivered" without a URL
42 828 tokens (~USD 0.15). Furthest any delivery has reached: database re-keyed (the #108 fix),
storage role minted (the #106 fix), boot smoke passed with dependencies installed (#108), the
CodeBuild image built — and `CreateExpressGatewayService` was refused:

- **Phase:** delivery (deploy step, Express service creation)
- **Symptom:** `ecs express: User: …/resources-dev-JobTaskDefinitionTaskRole…/… is not authorized
  to perform: iam:PassRole on resource: arn:aws:iam::…:role/mf-preview/mf-preview-app-c15b94b8…`
- **Root cause:** the PassRole grant for preview app roles was on the **api** task role. The api
  mints the role; the **job** passes it — it is the job that calls ECS with `taskRoleArn`. The
  earlier IAM simulation asked the api role and said "allowed": right question, wrong principal.
- **Graduated to:** `PassPreviewAppRolesToEcs` moved to the job task role (resources-stack, path +
  ECS-tasks fence), removed from the api (least privilege). `security-baseline` now asserts the
  job's three PassRole statements include the preview roles → ECS tasks, and that the api has
  none. The IAM simulation script asks the job role too.
- **Recurred, still OPEN (5th time):** `delivered` with `deployUrl: null`.

**Cost note:** two redeliveries so far have cost ~USD 0.25 combined and found three defects the
deploy half was hiding. The same two retries as rebuilds would have been ~USD 34.


## 2026-09-02 — job 3583768f (Ögonblick, redeliver of run 7) — "delivered" without a URL
27 757 tokens (~USD 0.10 — the point of the redeliver path, #107). Clone → docs → secret scan →
repo push (existing repository reused) all passed; the deploy was skipped, the bundle uploaded.
Two defects, both first-exercise bugs on the redelivery path, both fixed in the same PR:

- **Phase:** delivery (deploy step, database provisioning)
- **Symptom 1:** `POST /database → 500`: `permission denied to alter role … Only roles with the
  SUPERUSER attribute may change the SUPERUSER attribute` on
  `ALTER ROLE mf_app_… WITH LOGIN PASSWORD '…' NOSUPERUSER NOCREATEDB NOCREATEROLE`.
- **Root cause 1:** the re-key branch (role already exists — exactly the redelivery case, never
  reached by a fresh build) restated the role attributes. The RDS master user is `rds_superuser`,
  not SUPERUSER, and Postgres refuses even a no-op `NOSUPERUSER` from it (42501).
- **Graduated to:** password-only re-key (`ALTER ROLE … WITH PASSWORD`); the unit test now asserts
  no `ALTER ROLE` statement mentions SUPERUSER.
- **Symptom 2:** `npm run build failed (127): sh: vite: not found` while building the handover
  site for the bundle (best-effort, so the bundle still shipped).
- **Root cause 2:** a redelivery starts from a bare clone; a build starts from a seed with
  node_modules. Nothing installed dependencies on the clone path, so the boot smoke would have
  failed the same way had the deploy not been skipped first.
- **Graduated to:** `installDependencies` (extracted from the seed) runs after every clone.
- **Recurred, still OPEN (4th time):** `delivered` with `deployUrl: null`.

**Pattern note:** both are "the branch a fresh build never takes" — the same lesson as the
template's in-memory store and the fake provisioners: a path that only a retry exercises is
untested until the first retry. Worth a redelivery in the offline e2e (fake clients already
support it) before the next paid run.


## 2026-09-02 — job c15b94b8 (Ögonblick, M) — dogfood run 7, "delivered" without a URL
6.58 M budget-tokens (~USD 17). **Every gate green for the first time** — verify, acceptance-tests
(11 green), review, licence, acceptance-check — and the repository was delivered to GitHub
(`mjukvaruhuset/skapa-en-installerbar-pwa-…-c15b94b8`). The deploy step was then skipped, so no
live URL; the job still finished `delivered`.

**What the day's fixes bought, confirmed in this run:**
- The **durable store** (#104) removed run 6's persistence finding: review passed with the worker
  persisting through `app.store`. Review passing at all is new — runs 4 and 6 both died there.
- The **merge-repair retry** (#101) recovered a real conflict for the second time
  (`task/camera-capture`, 207 k tokens, merged `ok: true`).
- All five tasks merged; one (models-api) hit the 120-turn M cap and was completed by the repair
  valve, as designed.

- **Phase:** delivery (deploy step)
- **Symptom:** `object storage provisioning failed: POST /storage → 500` ×4, deploy skipped
  (fail-closed, correct). Api side: `AccessDenied … not authorized to perform: iam:TagRole on
  resource: arn:aws:iam::…:role/mf-preview/mf-preview-app-c15b94b8…`.
- **Root cause:** the api's `MintPreviewAppRoles` grant listed `iam:CreateRole` AND `iam:TagRole`
  under the `iam:PermissionsBoundary` condition. That condition key is supplied by CreateRole and
  NOT by TagRole, so the TagRole half of the grant never matched; CreateRole-with-tags makes an
  implicit TagRole call, which was denied. The pre-deploy IAM simulation
  (`simulate-principal-policy`) had asked only about CreateRole and PassRole, so it reported
  "allowed" — a check that verifies the calls you thought of, not the calls the SDK makes.
- **Graduated to:** infra fix — TagRole moved to the resource-scoped statement (no boundary
  condition), plus a `security-baseline` fence: **the boundary-conditioned statement may contain
  `iam:CreateRole` and nothing else**, and TagRole must exist unconditioned on the preview-role
  resource. The IAM simulation script now asks about TagRole too.
- **Recurred, still OPEN:** the order/job reads `delivered` with `deployUrl: null` — a build with
  no URL is presented to the customer as a delivery (first logged after run 4). The repo + bundle
  contract is honoured, but the status word is wrong for what the customer bought.

**Graduated to (second half):** a `redeliver` job mode (`POST /bff/orders/:orderId/jobs/redeliver`,
"Deliver again" on the job page). It clones the order's delivered repository and runs only the
delivery half — docs, secret scan, deploy, live acceptance, bundle — under the SOURCE job's
Express service, database and storage role. A hosting-side failure now costs a near-zero-token
retry instead of a ~USD 17 rebuild, which is what run 7 should have had.

**Next run's expectation:** with TagRole granted, the storage role mints, the deploy proceeds and
the live acceptance check runs for the first time on this app — against a database-backed store
and an S3-backed upload path, both of which are exercised live for the first time.


## 2026-09-02 — job 551edb6c (Ögonblick, M) — dogfood run 6, FAILED at review
7.97 M budget-tokens (~USD 20). Furthest any run has reached: verify ok, acceptance-tests ok
(11 green), **review failed** on two high findings — both genuine, neither seen before.

**What the day's fixes bought, confirmed in this run:**
- The **merge-repair retry** (#101) worked: `task/camera-capture` hit a conflict, the repair ran
  (198 k tokens) and merged `ok: true`. That is the exact failure that ended run 5.
- The **route-prefix guard** (#98) worked: routes came out at `apps/api/src/routes/bff/photos/`.
  Run 4's defect did not recur.

- **Phase:** gate (review)
- **Symptom 1 (high):** `isImage` accepted any mimetype starting with `image/`, so `image/svg+xml`
  is stored and re-served with that Content-Type — stored XSS in a gallery everyone at an event
  opens.
- **Symptom 2 (high):** photo metadata kept in an in-process `Map`, not a database — despite the
  spec requiring "photo metadata in the app's database" and a gallery shared across devices. Photos
  vanish on restart and never sync between phones.
- **Root cause of 2 — a template trap:** `templates/web/apps/api/src/plugins/store.ts` ships an
  in-memory key/value store, documented as "replace it with a real database client". It is typed,
  present and passes tests, so a worker needing persistence reaches for it and silently gets a Map.
  The provisioned Postgres goes unused.
- **Graduated to:** the template's `store` plugin is now **durable on Postgres whenever
  `DATABASE_URL` is set** (in-memory only when it is absent — local dev and tests), with the same
  interface, lazy connect and a self-created table. The worker's natural choice — `app.store` — is
  now the correct one, which removes the trap instead of gating against it (the gate alternative
  would still have needed the worker to hand-build a database layer correctly). Side effect, by
  design: `postgres` is now a template dependency, so `detectDatabaseNeed` fires for every
  template-derived app and every delivery gets its own database — the documented "errs wide"
  trade-off, one empty database per app that never persists anything. Symptom 1 is a
  worker-quality issue with no obvious template home — the review gate catching it is arguably the
  right answer.

### The pattern after six runs — worth reading before spending a seventh
Runs 1, 2, 3 and 5 died to **our machinery**; all four causes are fixed and guarded. Runs 4 and 6
died to **generated-code quality**, caught by the review gate — with *different* high findings each
time. That is the important distinction: it is not one bug left to fix. An M-class app (3 features,
11 criteria) has enough surface that the worker makes at least one high-severity mistake per
attempt, and the gate correctly refuses to deliver on any open high.

Two ways forward, and they are not exclusive:
1. **Keep closing template traps** (the in-memory store above is one). Each removes a whole class.
2. **Revisit the delivery bar per tier.** "Zero open high findings" may be right for a 3–5k kr
   build and wrong for a 500 kr demo, where delivering with the findings listed in HANDOVER.md is
   arguably more honest than not delivering at all. This ties directly to the pricing ladder
   (docs/backlog/strategy-2026-08-31.md) and is a product decision, not a harness one.

## 2026-09-01 — job 491b0b4a (Ögonblick, M) — dogfood run 5, FAILED at merge repair
4.46 M budget-tokens (~USD 11). Final run of the authorised five.

- **Phase:** repair
- **Symptom:** `merge repair of task/photo-gallery discarded the branch's changes (files identical
  to pre-merge main): apps/app/src/pages/GalleryPage.test.tsx`
- **Root cause:** the repair session resolved a merge conflict by keeping main's side verbatim,
  silently throwing away what the task had built.
- **Graduated to:** already gated — this is wave 12's conflict-repair validation (#75) doing
  exactly what it was added for. It refused rather than merging a branch whose work had vanished.
- **OPEN — the harness side:** detecting the bad repair is right, but *failing the whole task* is a
  blunt response. A repair that drops a branch should be retried (the session told what it did
  wrong) before the task is abandoned, the way a failed demo build now auto-retries once. As it
  stands one unlucky conflict resolution costs a whole paid build.

### Day summary — five runs, 2026-09-01
Never reached a live URL. What it bought instead: **8 real defects fixed and 5 deterministic guards
added**, in a system that had never once been exercised end to end by a real customer-shaped build.

Three separate wave-12 safety mechanisms proved themselves on real failures, which is the strongest
evidence of the day that the Gate C work was worth doing:
- **gate-on-merge** (#75) caught a task that passed its own scoped gate and broke the full suite
  after merging (run 3).
- **fail-closed delivery** refused to ship an app whose uploads would 500, while still delivering
  the repo and bundle (run 2).
- **conflict-repair validation** (#75) refused a repair that had discarded a branch's work (run 5).

The recurring lesson across the day, in three costumes: **a test double simpler than the real thing
deletes the failure mode.** The proxy stub never sent `content-encoding`; the service mock was
always present; a route's unit test calls the handler directly and never notices the wrong prefix.
Each is now a deterministic guard rather than a habit.

Where a paid run was NOT needed: four infrastructure defects (#94, #96, #97 and the CloudFormation
export deadlock) were found by pre-checks, deploys and IAM simulation. Pre-checking before run 3
saved a run outright. That is the cheapest debugging available and should come before every future
paid build.

## 2026-09-01 — job d5618973 (Ögonblick, M) — dogfood run 4, FAILED at review
Gates: verify ok, acceptance-tests ok, **review failed** (2 high open after one repair). 7.15 M
budget-tokens (~USD 18). The first failure of the day that was about the GENERATED CODE rather
than our own machinery.

- **Phase:** gate (review)
- **Symptom:** two high findings, one root cause — the backend registered photo routes at
  `/photos*` while the SPA fetched `/bff/photos`. Every gallery request and every `<img>` would
  have 404'd; the app would have shipped visibly broken.
- **Root cause:** the `/bff` prefix convention is documented in
  `.claude/rules/api-routes.instructions.md`, and the worker did not follow it for the new routes.
- **Graduated to:** template/gate — #98. Static scan of `src/routes/**/*.ts` asserting every
  `app.<method>('<path>')` sits under `/bff`, so the worker's OWN task gate fails long before
  review or delivery. Mutation-verified against this run's exact shape.
- **Cross-check:** **this is the second build the same mismatch has cost** — it sank the original
  guestbook delivery too. A documented prompt convention failed to prevent it twice, which is
  precisely the LEARNINGS rule for promoting to a gate. Note also why it kept surviving to
  expensive stages: a route's own unit test calls the handler directly and passes, so only
  something exercising the app like a browser (review, or `wiredSmoke` at delivery) ever notices.

## 2026-09-01 — job 7cc7ba7b (Ögonblick, M) — dogfood run 3, FAILED at post-merge gate
1.62 M budget-tokens (~USD 4) — cheap, because it died early.

- **Phase:** merge
- **Symptom:** `main is not green after merging task/foundation (rolled back)`; 24 api tests failed
  with `ENOENT: scandir 'apps/api/src/services/__mocks__'`.
- **Root cause:** template defect. `createAppMock` lists `src/<type>/__mocks__` to decide what to
  mock and threw when absent. Every delivered build begins by deleting the example Item entity —
  correctly — which removes the only service AND the only service mock. The scaffolding could not
  survive its own documented first step.
- **Graduated to:** template — #95 (ENOENT means "nothing to mock"; other errors still throw),
  fixed in `templates/web` and mirrored into `apps/api`. Three tests pin the contract.
- **Cross-check:** **wave 12's gate-on-merge is what caught this** (#75). The task passed its own
  diff-scoped gate and broke the full suite only after merging; before gate-on-merge it would have
  merged silently and surfaced later as something unrelated. The rollback also worked — main was
  restored rather than left broken. First real evidence that change earns its keep.

### Infrastructure defects found the same day, without burning a run
Each of these was caught by a pre-check or a deploy rather than by a paid build:
- **Egress allowlist missing `*.on.aws`** (#94): the Gate C acceptance check probes the delivered
  app's live URL from inside the job container, through a deny-by-default proxy that did not permit
  the preview domain. Every delivery would have deployed and then withheld its URL. Found by
  pre-checking before run 3 — saved a run.
- **Delivered apps could not reach their own database** (#96): RDS ingress allowed only the api's
  security group. The obvious fix (open 5432 to the VPC CIDR) was WRONG and an existing test said
  so — the build job is in that VPC, so a CIDR rule silently readmits it and undoes the M3
  invariant. Fixed properly by passing our own `networkConfiguration` to
  `CreateExpressGatewayService` (which takes flat `subnets`/`securityGroups`, NOT the standard
  `awsvpcConfiguration` wrapper — the compiler caught that guess). The M3 assertion was *sharpened*
  rather than weakened: it now names the job's security group and treats any CIDR rule as
  job-reachable.
- **EC2 rejected our security-group rule descriptions** (#97): `->` is outside EC2's allowed
  character set, and `cdk synth` does not validate descriptions — so it only surfaced when
  CloudFormation created the rule and rolled the stack back. Now asserted for every rule in all
  three environments.


## 2026-09-01 — job fab01a96 (Ögonblick, M) — dogfood run 2, DELIVERED without a URL
All five gates green (verify, acceptance-tests, review, licence, acceptance-check); repo pushed and
bundle uploaded; **7.73 M budget-tokens (~USD 19)**, ~1 h 50 m wall clock. The generated app is a
real PWA — react-router, `vite-plugin-pwa` manifest + service worker, camera capture, S3-backed
gallery with `sharp` thumbnails. `deployUrl: null` — the deploy was *correctly skipped*.

- **Phase:** delivery
- **Symptom:** `deploy` step failed closed: `object storage provisioning failed: POST /storage → 500`.
  Api-side: `Cannot read properties of undefined (reading 'provision')`.
- **Root cause:** `previewStorageService` (#87) was never registered in `apps/api/src/server.ts`.
  Routes are autoloaded; **services are imported and `.register()`ed by hand**, so a service can be
  written, unit-tested and given a working route while not existing at runtime — and the symptom is
  a 500, not a 404, which reads like a bug *in* the service rather than a missing wire.
- **Graduated to:** gate/test — #92. Static drift guard (`apps/api/test/serviceRegistration.test.ts`)
  reads `src/services/*Service.ts` and fails naming any service missing from `server.ts`.
  Mutation-verified.
- **Cross-check:** **1 396 tests passed over the top of this.** `createTestApp()` auto-mocks services
  from `__mocks__/`, so the real registration list is never exercised by any test. Same lesson as
  run 1's proxy stub, in a different costume: *the test double was more complete than the system,
  so the missing piece was invisible.* Both now have deterministic guards.

### What went RIGHT (worth recording, not just defects)
- **Gate C's fail-closed rule did its job on its first real outing.** Faced with a missing storage
  capability, delivery refused to ship an app whose every upload would 500, and still delivered the
  repo and bundle. The customer gets no broken URL — exactly the designed behaviour.
- The five-gate chain passed on a genuinely non-trivial app (PWA + camera + object storage) that
  exercises surface nothing else has: service worker, `getUserMedia`, binary upload, thumbnailing.
- `detectStorageNeed` fired correctly — it saw `@aws-sdk/client-s3` / `@fastify/multipart` in the
  generated `package.json` and demanded provisioning, which is what surfaced the missing service.

### Efficiency re-measurement (closes the OPEN item from the wave-3 entry)
7.73 M budget-tokens for an M-class, 3-feature/11-criterion app. The 2026-08-26 S-class baseline was
190 k + 1.25 M for a much smaller spec, so this is the first M-class datapoint rather than a
like-for-like comparison — **the wave-3 savings estimate still has no clean before/after**. Recording
the number so the next M-class run has a baseline; the estimate stays unverified.


## 2026-09-01 — job 7bee3234 (Ögonblick, shared event-camera PWA, M) — dogfood run 1, FAILED
First run driven end-to-end through the **portal** as a customer (magic link → order → spec chat →
freeze → Stripe test payment → webhook auto-start), not seeded through the api. That path itself
worked flawlessly; everything below is what it exposed.

- **Phase:** plan
- **Symptom:** `planning failed: terminated` after ~45 s, `tokensUsed: 0`, no gate ran. The egress
  proxy log shows the CONNECT tunnel to `api.anthropic.com` established and held for the full 45 s,
  so the request went out and the model did the work.
- **Root cause:** `fetch` (undici) transparently DECOMPRESSES a gzip response but leaves
  `content-encoding: gzip` on the headers. `apps/job/src/anthropicForwardProxy.ts` (Gate B A1, #65)
  stripped `content-length` and `transfer-encoding` but not `content-encoding`, so the caller got
  plain JSON labelled as compressed, failed to inflate (`Z_DATA_ERROR: incorrect header check`) and
  undici surfaced it as `TypeError: terminated`. Only the response framing was wrong.
- **Graduated to:** sandbox/infra + test — #90. The regression test now mimics undici (decoded body,
  header still present) and reproduces the exact production error without the fix.
- **Cross-check:** the six existing proxy tests could never have caught it — their stub upstream
  returns plain bodies with **no `content-encoding` at all**, so the header-forwarding path was
  untested against a compressed response. Lesson: a fake that is *simpler* than the real dependency
  silently deletes the failure mode. **Every build since #65 merged (2026-08-31 09:00) would have
  failed identically**; none ran, so the factory was broken and silent for a day.

- **Phase:** delivery
- **Symptom:** the delivered app is named after the spec's goal SENTENCE, not the order. Slug
  `skapa-en-installerbar-pwa-som-fungerar-som-en-dela-7bee3234`, app name a truncated Swedish
  paragraph — while the order is called "Ögonblick".
- **Root cause:** `deliveryTarget()` derives slug/appName from `spec.goal` when the order name is
  available and is the obviously better source.
- **Graduated to:** **OPEN** — a customer's repo would carry that name. Small fix, real
  delivery-quality defect.

- **Phase:** ops
- **Symptom:** dev had been running stale code for hours; five consecutive `deploy.yml` runs failed,
  silently. Nothing alarmed.
- **Root cause:** CloudFormation cross-stack deadlock — `resources-dev` drops the `JobLogGroup`
  export (wave 11 #44 removed the MetricFilters that consumed it) while the deployed `ops-dev` still
  imports it, and the pipeline deploys producer→consumer, which is exactly backwards for REMOVING an
  export. Cleared by deploying `ops-dev` alone first.
- **Graduated to:** **OPEN** — two gaps: (a) nothing alerts on a failed deploy, so dev can sit stale
  indefinitely; (b) the ordering hazard will recur the next time an export is removed.

### Calibration notes from the same run (not defects)
- The spec classified **M**, not the **S** PLAN.md predicted: the engine extracted 11 acceptance
  criteria from the same content PLAN.md counted as 6. Size (and therefore budget and price) is
  sensitive to how finely criteria are split — worth knowing before quoting.
- The spec engine answered in **Swedish** to an English prompt. Defensible default for a Swedish
  company, but it is an unmade product decision.
- Efficiency re-measurement (the OPEN item below) could **not** be done: the run spent 0 tokens.
  It carries to run 2.

