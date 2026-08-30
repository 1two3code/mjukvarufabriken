# Stream: m4-gates — QA gates in the build job (PLAN.md M4)

Areas: `packages/harness` (`src/job/*`), `packages/models` (gate/report schemas), `apps/job`
(events), `apps/api` ONLY `routes/bff/jobs/getJob*.ts` response schemas if a new field is needed.
Do not touch persistence code, portal, site, infra. Load the `claude-api` skill before writing
Agent SDK / Anthropic calls.

## Context
`packages/harness/src/job/orchestrator.ts` runs plan → tasks (Agent SDK workers in worktrees) →
merge → `verifyRepo` (lint + test) and fails closed. Tonight's Fargate run (job `266a218a`,
docs/M3-REVIEW.md era) built a 4-task S job in 44 min / 2.5M budget-tokens; the final verify
caught a real defect. M4 adds the gates that turn "lint passes" into "the spec is met".

## Deliverables (the four M4 boxes)
1. **Acceptance tests from criteria.** After all tasks are merged, one Agent SDK session
   ("acceptance-tests" gate) reads the spec's acceptance criteria (ids `f<n>.c<m>` as in the
   plan) and writes one test per criterion into the customer repo under
   `apps/app/src/acceptance/<id>.test.tsx` (or api test dir when the criterion is server-side),
   each test tagged with its criterion id in the title. Tests must pass; if they fail, ONE fix
   session on the app code (never on the tests) then re-run; still failing → gate fails.
   The template app has no test setup — the gate session must set up Vitest + Testing Library in
   the customer repo if missing (it is allowed to `npm install`; `syncDependencies` in merge.ts
   shows the pattern for keeping main's node_modules current).
2. **Independent review gate.** A read-only Agent SDK session (tools Read/Glob/Grep/Bash with a
   system prompt that forbids edits) reviews `git diff <seed-commit>..main` for correctness +
   security and returns findings via a strict tool call (Zod `ReviewFinding`: severity
   high/medium/low, file, line, claim, failureScenario). High/medium findings → one fix session →
   re-run lint/test; still-open high findings fail the gate. Low findings are recorded, not fixed.
   Waivers: `Job.gateWaivers: string[]` (finding ids) honoured if present on the job row.
3. **Acceptance-check gate.** A session maps every criterion id to evidence: the passing
   acceptance test file(s) and, for UI criteria, a short note of what the test asserts. Output a
   Zod-validated `AcceptanceReport` (criterion → { evidence[], status: met|unmet|unknown }).
   Any `unmet`/`unknown` fails the gate.
4. **Fail closed + notify.** `GateReport` (per gate: name, ok, startedAt, durationMs, tokens,
   summary, details) is emitted as a `gate` job event after each gate and stored on the job
   (`jobs.gates jsonb`, migration `0005_jobs_gates.sql` — only this migration, the persistence
   stream owns 0004). No green gates → status `failed` with reason listing the failed gates.
   `apps/job` sends an email through the api's email conventions is NOT available in the job —
   instead emit a `notify` event with `{ to: 'admins', subject, text }` payload; the api's job
   event ingestion (leave a clearly marked TODO in `apps/api/src/services/jobService.ts`) will
   forward it once the m3-hardening stream lands. Keep the interface simple.
5. Gates count toward the token budget and honour abort/kill like tasks. Order:
   verify(lint+test) → acceptance-tests → review → acceptance-check.
6. Unit tests with fakes for each gate's control flow (pass, fail, fix-then-pass, abort), the
   gate ordering, and the report shape; mirror `packages/harness/test/job`.

## Verification
- `npm run lint`, `npm test`, `npm run build`.
- One real run is expensive (≈ USD 7, 45 min on the S demo spec); do NOT run a live job in this
  stream. Instead add `packages/harness/scripts/gates-demo.ts` that runs only the gates on an
  already-built repo directory (`--repo <dir>`), for the main session to use on the next
  Fargate/local run. Document it in the report and in `apps/job/README.md`.
- PLAN.md M4: tick boxes 2–5 only with a note "unit-verified, live run pending" — the main
  session ticks fully after a live run.
