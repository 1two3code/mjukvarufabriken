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
