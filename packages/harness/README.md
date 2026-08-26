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

`src/job/gates.ts` — `runGates` runs `verify → acceptance-tests → review → acceptance-check` after the last merge, one `GateReport` (from `@mf/models`) per gate, emitted as a `gate` event; the first red gate stops the chain (fail closed), a throwing port is red, an abort stops without a report. `src/job/gateSessions.ts` holds the live Agent SDK gates (`acceptanceTestsGate`, `reviewGate`, `acceptanceCheckGate`): read-only sessions use `readOnlyTools` + a JSON-schema `outputSchema` (Zod-validated `structured_output`), fix sessions get the full worker tools and exactly one attempt. `runJob` emits `notify` for the admins on `failed`/`killed`. Tests: `test/job/gates.test.ts` (control flow with fake ports), `test/job/gateSessions.test.ts` (each gate with a mocked `runSession` on a real temp git repo). `npm run gates:demo -- --repo <dir> --spec <json>` runs the gates alone on a built repo (see apps/job/README.md).

## Build-job orchestrator (M3, skeleton)

`runJob(spec, budget)` is a typed placeholder; `JobSpec`, `JobBudget`, `JobStatus` and `JobResult` are the contract the api and the job container will share. `JobSpec.spec` is the frozen `Spec` from `@mf/models`.

M3 intent: a job runs as a container on ECS Fargate, receives a frozen spec + budget (never customer secrets), plans a task DAG, runs Claude Agent SDK workers in parallel git worktrees, merges, and streams progress events to `job_events` in `@mf/db`. Hard token budget, kill switch, egress allowlist (npm, github, anthropic). `@anthropic-ai/claude-agent-sdk` is added when M3 starts.
