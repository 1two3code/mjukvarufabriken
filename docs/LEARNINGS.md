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

