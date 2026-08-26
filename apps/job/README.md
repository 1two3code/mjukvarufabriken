# @mf/job — build-job container

One container = one job. The entrypoint (`src/index.ts`) reads `JOB_ID`, loads the job row and its frozen spec from Postgres (`@mf/db`), seeds `/work/repo` from the golden template baked into the image (`templates/web`, `git init`, one commit), then runs the `@mf/harness` orchestrator and writes status, `tokens_used` and events back. Same code path locally and on Fargate.

```
plan (Anthropic SDK, PLAN_MODEL)          → job_events: planned {plan}
  └─ ready tasks × maxWorkers in parallel  → task_started / task_finished / task_failed
       each: git worktree task/<id> → Agent SDK query() → npm run lint + npm test → commit
  └─ merge each finished branch into main  → merge {ok}
       (one repair session on conflict, fail closed otherwise)
  └─ QA gates on main (M4), fail closed, each → gate {GateReport}
       verify (lint + test) → acceptance-tests → review → acceptance-check
  └─ done | failed | killed (+ notify {to: 'admins', subject, text} on anything but done)
```

## QA gates (M4)

After the last merge `@mf/harness` `runGates` runs four gates in order; the first red one ends the job with status `failed` and a reason listing it. Every gate emits a `gate` event whose payload is a `GateReport` (`name, ok, startedAt, durationMs, tokens, summary, details`), counts toward the token budget and honours the abort signal (budget / wall clock / kill) like a task.

| Gate | Session(s) | Passes when |
|---|---|---|
| `verify` | none | `npm run lint` + `npm test` green on main |
| `acceptance-tests` | 1 writer (full tools) + at most 1 fix on app code | one `<id>.test.ts[x]` per criterion (`apps/app/src/acceptance/` or `apps/api/test/acceptance/`) exists and lint + test are green. The fix session may not touch the tests — they are restored from the test commit afterwards |
| `review` | 1 read-only reviewer (structured `ReviewFinding[]`) + at most 1 fix + 1 re-review | no unwaived **high** finding open after the fix; medium/low are recorded in `details`. Finding ids are `<file>:<line>`; `jobs.gate_waivers` lists ids an admin has waived |
| `acceptance-check` | 1 read-only session (structured `AcceptanceReport`) | every criterion id is `met` with evidence (test file + what it asserts) |

On `failed`/`killed` the orchestrator also emits a `notify` event (`{ to: 'admins', subject, text }`); the api forwards it as an email once job events go through the api (TODO in `apps/api/src/services/jobService.ts`). Gate reports are meant to land on `jobs.gates` (migration `0005_jobs_gates.sql`) — the `@mf/db` mapping is pending (TODO in `src/index.ts`).

### Running only the gates on a built repo

```
npm run gates:demo -- --repo /work/repo --spec spec.json [--seed <commit>] [--waive apps/api/src/x.ts:12]
npm run gates:demo -- --repo /work/repo --job job.json      # { spec, gateWaivers? } e.g. a jobs row
```

Live Agent SDK sessions (needs `ANTHROPIC_API_KEY`, honours `WORKER_MODEL`); prints one report per gate, the JSON reports at the end, exit 0 only when all gates are green. `--seed` is the commit the review diffs against (default: the repo's root commit — the seed commit of a job repo).

## Configuration (env)

| Variable | Purpose |
|---|---|
| `JOB_ID` (or argv) | Job to run — set by the api's `ecs:RunTask` override or `npm run job:dev -- <id>` |
| `DATABASE_URL` / `DATABASE_SECRET_ARN` | Postgres; the ARN is the RDS-generated secret, resolved at startup |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY_SECRET_ARN` | Model access for planner + workers |
| `GITHUB_TOKEN` / `GITHUB_TOKEN_SECRET_ARN` | M5: create + push the customer repo (`GITHUB_ORG`, default `mjukvaruhuset`); missing → the `repo` delivery step fails closed |
| `APPRUNNER_CONNECTION_ARN`, `APPRUNNER_INSTANCE_ROLE_ARN` | M5: App Runner preview of the customer api from the pushed repo; missing → `deployUrl: null` + notify |
| `ARTIFACTS_BUCKET` | M5: bundle (`deliverables/<jobId>/`) + SPA build destination |
| `DELIVERY_DRY_RUN=1` | Log the GitHub / App Runner / S3 calls instead of making them |
| `PLAN_MODEL`, `WORKER_MODEL` | Model overrides (default `claude-sonnet-5`) |
| `WORK_DIR`, `TEMPLATE_DIR` | `/work` and `/usr/src/templates/web` in the image |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY=1` | Egress through the allowlist sidecar |

No customer secrets are passed in: the container only sees the job id, the database and the Anthropic key. The database location and secret ARNs are dropped from the environment before any worker session starts (`@mf/harness` `sandboxEnv` also strips `DATABASE_*`, `*_SECRET_ARN`, `AWS_*`, `ECS_*`), so the agent's shell only inherits the Anthropic key and the proxy settings — the database credential itself is still reachable through the task role until the job reports via the api (see docs/M3-REVIEW.md #18). The GitHub token is read once at start-up and removed from the environment before any session starts (it only reaches the Octokit client and the one `git push` argument list). After green gates the job delivers (M5): handover docs committed, repo `mjukvaruhuset/<app>-<job prefix>` pushed, App Runner preview, bundle in S3 — see packages/harness/README.md "Delivery"; `repositoryUrl` on the job row, the `Deliverable` record in the last `delivery` event.

## Budget, kill switch, egress

- **Budget**: every planner/worker/merge message's usage is summed in one `BudgetTracker`; crossing `budget.maxTokens` (or `maxDurationMinutes`) aborts every in-flight session via a shared `AbortController` and the job ends `failed` with reason `budget exceeded`. `tokens_used` is persisted after every task and merge.
- **Kill switch**: `POST /bff/admin/jobs/:jobId/kill` sets `jobs.status = 'killed'` and calls `ecs:StopTask` when a task ARN is stored. The orchestrator also polls the row every 10 s and aborts itself, so a kill works even if StopTask lags.
- **Egress allowlist**: `proxy/` builds a tinyproxy sidecar (`FilterDefaultDeny`, see `proxy/filter`: npm, GitHub, Anthropic). On Fargate it runs in the same task; the job container gets `HTTP_PROXY`/`HTTPS_PROXY` pointing at `localhost:8888`, `NO_PROXY` for the ECS credential endpoint + AWS APIs, and the job security group allows only 443/80 out plus 5432 to the database. Note: Fargate sidecars share the task ENI, so the security group cannot distinguish proxy traffic from a process that ignores `HTTPS_PROXY`; a hard network fence needs a proxy in its own task/SG (see TODO-EXTERNAL.md). Locally, docker compose puts the job on an `internal` network where only the proxy has internet, which *is* a hard fence — that is where the allowlist is verified.

## Local runs

```
docker compose up -d                          # Postgres 17 on :5432
npm run db:migrate                            # apply packages/db/migrations
npm run db:seed                               # queued demo job, prints <id>
npm run job:dev -- <id>                       # run it here (uses root .env: ANTHROPIC_API_KEY, DATABASE_URL)

docker compose --profile job build            # job + egress-proxy images
JOB_ID=<id> docker compose --profile job run --rm job   # same job, behind the proxy
```

The api's `GET /bff/jobs/:id` and `GET /bff/jobs/:id/events?after=<id>` read the same tables, and the portal page `/orders/:orderId/job` polls them.
