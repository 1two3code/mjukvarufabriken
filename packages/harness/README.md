# @mf/harness

The model harness: every Anthropic call the platform makes goes through this package (the api depends on `@mf/harness`, never on the SDK directly).

## Spec engine (M2)

`createSpecEngine({ client, model? })` → `{ model, nextTurn(draft, userMessage) }`.

- `client` is any object with `messages.create` (`SpecEngineClient`) — the real `new Anthropic()` in the api, a stub in tests.
- `model` defaults to `SPEC_MODEL` env, then `claude-sonnet-5`.
- One request per turn: a single **forced tool call** (`update_spec`, `strict: true`) whose input schema mirrors `SpecSchema` from `@mf/models` plus `questions` and `assistantMessage`. The model always returns structured JSON; the input is validated with Zod before it is stored.
- `nextTurn` returns `{ assistantMessage, spec, openQuestions, complete, usage }`. `complete` is `isSpecComplete(spec)` (deterministic, in `@mf/models`); when complete the engine sets `spec.sizeClass` via the price estimator and clears the questions.
- The system prompt: Mjukvaruhuset's spec engineer — extract/refine from the whole conversation, ask ≤ 3 targeted questions per turn, answer in the customer's language (sv/en), never invent requirements. The current draft spec is appended to the system prompt on every turn so the model refines instead of restarting.

`priceEstimator.ts` — pure, keyword-driven (`sv` + `en`): **S** ≤ 3 features and ≤ 6 acceptance criteria; **L** ≥ 8 features or any of payments / auth with roles / ≥ 2 third-party integrations / realtime; **M** otherwise. `priceForSize` = `{ S: 15 000, M: 45 000, L: 120 000 }` SEK ex moms.

### Demo against the live API (opt-in)

```
npm run spec:demo
```

Runs a scripted 3-turn Swedish conversation and prints the resulting spec, size class and price. Exits 0 with `skipped: ANTHROPIC_API_KEY not set` when the key is missing (it reads the root `.env`). The unit tests never call the API.

### Tests

`npm test -- --project @mf/harness` — estimator rules and the engine with a fake client (canned `tool_use` responses), including a question → answer → complete sequence.

## QA gates (M4)

`src/job/gates.ts` — `runGates` runs `verify → acceptance-tests → review → licence → acceptance-check` after the last merge, one `GateReport` (from `@mf/models`) per gate, emitted as a `gate` event; the first red gate stops the chain (fail closed), a throwing port is red, an abort stops without a report. `src/job/gateSessions.ts` holds the live Agent SDK gates (`acceptanceTestsGate`, `reviewGate`, `acceptanceCheckGate`): read-only sessions use `readOnlyTools` + a JSON-schema `outputSchema` (Zod-validated `structured_output`), fix sessions get the full worker tools and exactly one attempt. `runJob` emits `notify` for the admins on `failed`/`killed`. `src/job/gates/licence.ts` is the deterministic licence gate (no model call): `npm ls --all --json --long` in the repo, every installed non-private package's licence read from its `package.json`, denylist every `GPL` / `AGPL` / `SSPL` spelling (`-only`, `-or-later`, deprecated `GPL-3.0`, `GPLv3`; `LGPL` and `WITH …-exception` pass), `UNLICENSED` / no licence, and non-SPDX free text (`SEE LICENSE IN …`, `Proprietary`) (SPDX expressions are parsed: `OR` passes when one alternative is fine, `AND` fails when one part is denied, parentheses group); an npm-level `npm ls` error or an empty tree throws (red, never green); workspace members (paths inside the repo outside `node_modules`) are skipped, packages `missing` on the build platform are listed in the file and the report, waivable per package with `licence:<pkg>@<version>` in `jobs.gate_waivers`; it always writes `THIRD-PARTY-LICENCES.md` (counts by licence + package/version/licence/repository) into the repo root so delivery commits and ships it, and its report `details` (`LicenceGateDetails`) carry the counts, violations and waived packages. Tests: `test/job/gates.test.ts` (control flow with fake ports), `test/job/gates/licence.test.ts` (fixture trees + one real `npm ls`), `test/job/gateSessions.test.ts` (each gate with a mocked `runSession` on a real temp git repo). `npm run gates:demo -- --repo <dir> --spec <json>` runs the gates alone on a built repo (see apps/job/README.md).

## Delivery (M5)

`src/job/delivery/` — `deliver()` runs after green gates when `runJob` gets a `delivery` target and `ports.deliver` (`createLivePorts({ delivery: createLiveDeliveryClients(...) })`): **docs** (HANDOVER.md, TEST-REPORT.md, README.md, apprunner.yaml — tables generated deterministically from the gate reports in `docs.ts`, the "what was built" prose from one read-only Agent SDK session in `prose.ts`, spec goal as fallback; committed on main) → **repo** (private `mjukvaruhuset/<slug>` via Octokit, `git push` with the token only in that one process's arguments, customer invited as admin when the target has a GitHub login, else `transferPending`) → **deploy** (App Runner source deployment from the pushed repo + the SPA build uploaded to `deliverables/<jobId>/site/`; best effort — a failure leaves `deployUrl: null` and emits a `notify`) → **bundle** (`repo.zip` = `git archive main`, docs, `gates.json`, `acceptance.json` under `deliverables/<jobId>/`). Every step is a `delivery` event; the final one carries the `Deliverable` record the api serves. Every external system sits behind a small interface (`GitHubClient`, `DeployClient`, `ArtifactStore`, `ProseWriter`) with an in-memory fake and a dry-run variant that only logs. Tests: `test/job/delivery/` (real temp git repo + fakes, dry-run, abort, every failure mode) and the orchestrator delivery cases.

```shell
npm run delivery:demo -- --repo <built repo> --dry-run [--spec spec.json] [--gates gates.json] [--github-login octocat]
```

The demo commits the docs on the repo's main — use a scratch clone. Without `--dry-run` it needs `GITHUB_TOKEN`, `APPRUNNER_CONNECTION_ARN` (+ `APPRUNNER_INSTANCE_ROLE_ARN`) and `ARTIFACTS_BUCKET` (see TODO-EXTERNAL.md).

## Build-job orchestrator (M3, skeleton)

`runJob(spec, budget)` is a typed placeholder; `JobSpec`, `JobBudget`, `JobStatus` and `JobResult` are the contract the api and the job container will share. `JobSpec.spec` is the frozen `Spec` from `@mf/models`.

M3 intent: a job runs as a container on ECS Fargate, receives a frozen spec + budget (never customer secrets), plans a task DAG, runs Claude Agent SDK workers in parallel git worktrees, merges, and streams progress events to `job_events` in `@mf/db`. Hard token budget, kill switch, egress allowlist (npm, github, anthropic). `@anthropic-ai/claude-agent-sdk` is added when M3 starts.

## Worker efficiency (wave 3)

`docs/EFFICIENCY.md` explains where a worker session's tokens go and the levers. The knobs live in `workerLimits` (`src/job/worker.ts`): the task gate is scoped to the `apps/*` workspaces in `task.areas` (`npm run lint -w <ws>`, `npx vitest run <ws>`) but widened to the full repo when the task's diff touches anything outside them (`packages/*` tasks and the merge/verify gate stay full-repo; a scoped Vitest run that collects nothing while the workspace has test files is red), the implementation session is capped by spec size (S 60 / M 100 / L 150 turns) with one 60-turn second session that repairs a red gate or finishes a capped task — every cap hit is logged and recorded as `notes` on the task outcome / `task_finished` event and in the `task_failed` reason — the system prompt tells the worker to gate at most twice and to iterate with `tsgo --noemit`, and points at CLAUDE.md instead of having it read up front. Sessions never inherit a `DISABLE_PROMPT_CACHING*` switch (whether the SDK's own caching is on is confirmed by `cache_read_input_tokens` on the next live job, not by code); `WORKER_EFFORT=low|medium|high|xhigh|max` sets the SDK effort (default: the model's). All savings are estimates until the next live job.
