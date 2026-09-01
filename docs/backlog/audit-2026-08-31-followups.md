# External audit (PR #73) — triage outcome and what is left

Wave 13 (2026-09-01) independently re-verified all 6 P0 + 12 P1 findings from the external audit
in `docs/CODE-AUDIT-2026-08-31.md` **against the real code before fixing anything**, then fixed
only what survived. Verdicts: **13 CONFIRMED, 6 OVERSTATED, 0 outright wrong.** The audit is
substantively good — the corrections below are about severity, reachability and sequencing, not
competence.

## Fixed and merged
| # | Finding | PR |
|---|---------|-----|
| P0-1 | Unscoped artifacts-bucket grant negating the scoped one on the CodeBuild role | #80 |
| P0-5 | Live deploy would publish a plain-HTTP API; guard moved to synth (`infra/bin/app.ts`) | #80 |
| P1-8 | CI security gates were `continue-on-error`; no `permissions:` block | #80 |
| P0-3 | Licence manifest deleted by a later gate's `git clean` — every delivery shipped without it | #81 |
| P0-4 | `??` vs `||` made an empty `seedCommit` a green review no-op; empty diff is now red | #81 |
| P1-12 | Unbounded `exec` capture could OOM the container after a full budget was spent | #81 |
| P0-2 | `awaiting_approval` missing from `orders_status_check` → paid build stuck in `building` | #82 |
| P1-2 | Unbounded spec-chat spend (four ceilings incl. a global one) | #82 |
| P1-6 | Portal could never render Swedish (no detector, no `lng`) | #83 |
| P1-10 | Polling never stopped on terminal jobs; `killJob` invalidated nothing | #83 |

## Where the audit was overstated (recorded so it is not re-litigated)
- **T1 — its flagship systemic claim is false as written.** *"No test in this repo has ever
  executed a real SQL statement"* (bolded, in the Verdict) is wrong: `packages/db/test/migrations.test.ts`
  drops/recreates the schema, applies all migrations and queries `information_schema` against real
  Postgres, gated on `TEST_DATABASE_URL`, which CI sets. The **narrower true version** stands and is
  worth doing: no *api service/route* test touches real SQL (they all use `createMemoryRepositories`,
  which has no CHECK constraints, FKs or transactions), which is exactly why P0-2 survived 1175 green
  tests. Consequence: the audit's Day-2 sequencing — a full integration suite *before* a ten-line
  migration — is wrong. P0-2 shipped with a static drift guard instead; the behavioural suite can
  land on its own schedule.
- **P0-6 (tokens in `localStorage`)** — the storage fact is real and worth fixing, but three of the
  four claims making it a P0 fail: a strict `script-src 'self'` CSP *is* deployed on the surface that
  matters, there is no HTML-injection sink in the portal today, and there are no untrusted users.
  Real P1/P2, not P0.
- **P1-11 (unschedulable plan ships green)** — shape real, unreachable: `PlanSchema.tasks` is
  `.min(1)`, so the empty-plan path cannot fire. ~10 lines to close next time `orchestrator.ts` is
  open; not a Day-4 priority.
- **P1-7 (concurrent gate reports lost)** — the read-modify-write is real, but `runGates` is a strict
  sequential `for` loop that stops at the first red, so there is no concurrency to lose a report.
  Note the audit's own "what is genuinely solid" section praises `ApiReporter`'s serialised queue and
  then bases this finding on it not existing — a cross-check failure in the audit.
- **P0-1's exploit chain** — presented as direct; it is not. `sandboxEnv()` strips
  `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` from every child process and workers run as a separate
  uid, so reaching the task role is materially harder than described. Fixed anyway (one deleted line).
- **P0-5's trigger** — its summary says the vulnerable path "fires on push to `main`". It does not:
  `deploy.yml` gates live on `workflow_dispatch` only. The audit's own appendix says this correctly.

## Still open — deliberately deferred, with the reason
- **P1-3 magic-link email bombing** (CONFIRMED, no global/IP cap). Not urgent while every deployed
  env uses the `log` transport — but **must close before the first live deploy**, since flipping
  `transport: 'ses'` is the single change that turns it into a sender-reputation event.
- **P1-4 licence gate fail-open for not-installed packages** (CONFIRMED). Exposure is narrower than
  stated: the `missing` set is dominated by os/cpu-gated optional binaries that are near-uniformly
  MIT, and the manifest already names them in prose.
- **P1-5 delivery failure after push orphans a billing ECS service** (CONFIRMED). Tens of USD/month,
  in our own account, discoverable in the console — a genuine leak only once builds run unattended.
- **P1-9 no client/pool timeouts** (CONFIRMED). Every consequence is an availability failure in a
  single-tenant deployment with one admin and no traffic; nothing here can produce a wrong build
  result or leak anything.
- **P1-1 gate scope unpinned** (CONFIRMED, the deepest one): the gate is the customer repo's own
  `npm test`, and nothing pins what it covers. Snapshot the gate contract at `seedCommit`
  (workspaces with a lint script, root test script, vitest `projects`) and fail closed when coverage
  shrinks.
- **P0-6 remainder**: refresh token to an `httpOnly; Secure; SameSite=Strict` cookie scoped to
  `/bff/auth/refresh`, access token in memory only; `@fastify/helmet`; replace wildcard CORS.
- **The structural one behind P0-1**: `codebuild:StartBuild` accepts `buildspecOverride` and **no IAM
  condition key can restrict it**, so granting it to the untrusted job task role is unfixable at the
  IAM layer. The repo already solved the identical problem for the database by routing through the
  api's per-job-token `/internal/jobs/:id` endpoint. Move image-build kickoff there and drop
  `StartBuild` + `PassRole` from the job role entirely.
- **Real-Postgres suite for api services/routes** (T1's true core).
- The audit's P2 list (indexes, dropped FKs, `double precision` feeding a Stripe meter, api container
  as root, tinyproxy on `0.0.0.0`, no error boundary, no route-level code splitting) is untriaged and
  still worth mining.

## Offline e2e clone flake (seen once in CI, run 33478129110)
```
git clone -q --no-hardlinks --no-checkout <tmp>/repo <tmp>/worktrees/foundation failed (128)
fatal: failed to copy file to '<tmp>/.../.git/objects/19/…': No such file or directory
```
Not caused by the branch under test — neither the new output cap (128 MiB, drops oldest bytes, never
kills the child; the clone is `-q`) nor the Vitest-report change touches the clone path. Same commit
passed the full suite locally and a targeted re-run, and the CI re-run was green. The error is on the
destination path git creates itself, matching the flake class already recorded in `6ab1eb4`
("cleanup raced a killed session's git").

**Worth fixing anyway:** a transient clone failure currently fails a whole task. In a test that costs
seconds; in production it costs a paid build. Retry `createWorktree`'s clone once on a
filesystem-shaped 128, the way temp-root removal already retries.
