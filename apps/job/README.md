# @mf/job — build-job container

One container = one job. The entrypoint (`src/index.ts`) reads `JOB_ID`, loads the job and its frozen spec through a `JobReporter` (`src/reporter.ts`), seeds `/work/repo` from the golden template baked into the image (`templates/web`, `git init`, one commit), then runs the `@mf/harness` orchestrator and streams status, `tokens_used` and events back through the same reporter. Two implementations, one code path:

| Reporter | Selected by | Used |
|---|---|---|
| `api` | `API_URL` + `JOB_TOKEN` (the api's `ecs:RunTask` container override) | Fargate. First call is `POST /internal/jobs/:id/token`: the bootstrap token from the override is exchanged for a fresh one only the job process holds (the override is visible in the task environment — `/proc/*/environ` from any worker shell — in `ecs:DescribeTasks` and in CloudTrail, so it is dead before the first worker starts). Then `GET /internal/jobs/:id` (spec, budget, waivers, kill flag), `POST /internal/jobs/:id/events` (batch, every event numbered `seq` so a retried batch is stored once) and `PATCH /internal/jobs/:id` (status/tokens/plan/gates/urls; status only moves forward, a terminal status or an admin kill revokes the token). Bearer = a random 32-byte per-job token whose sha256 is on the row (`jobs.report_token_hash`); it can reach nothing but its own active job. Retries 5xx/network errors, gives up on 4xx (a 404 on a write is an error, not a dropped event), truncates `reason` to 20 000 chars, sends events strictly in order |
| `db` | `DATABASE_URL` | `npm run job:dev` and the docker compose `job` profile against the local Postgres |

The container never holds a database credential on Fargate (docs/M3-REVIEW.md #18): no `DATABASE_SECRET_ARN`, no secret grant, no 5432 security-group rule. The api forwards `notify` events to `AUTH_ADMIN_EMAILS` and appends `gate` reports to `jobs.gates` on ingestion.

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

On `failed`/`killed` the orchestrator also emits a `notify` event (`{ to: 'admins', subject, text }`); the api mails it to the admins when it ingests the event (`jobService.reportEvents`) and appends every `gate` payload to `jobs.gates` (migration `0005_jobs_gates.sql`); the final PATCH stores the full list again.

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
| `API_URL`, `JOB_TOKEN` | Fargate: the api to report to and the per-job **bootstrap** token (RunTask override — never logged by the api, but visible to `ecs:DescribeTasks`/CloudTrail and in `/proc/<pid>/environ`; exchanged for a fresh token before any worker starts, so what leaks is dead) |
| `DATABASE_URL` | Local: report straight to Postgres instead |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY_SECRET_ARN` | Model access for planner + workers |
| `PLAN_MODEL`, `WORKER_MODEL` | Model overrides (default `claude-sonnet-5`) |
| `WORK_DIR`, `TEMPLATE_DIR` | `/work` and `/usr/src/templates/web` in the image |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY=1` | Egress through the allowlist sidecar |

No customer secrets are passed in: the container only sees the job id, the report token (or the local database url) and the Anthropic key. The token, the database location and the secret ARNs are dropped from Node's environment before any worker session starts (`@mf/harness` `sandboxEnv` also strips `DATABASE_*`, `*_SECRET_ARN`, `AWS_*`, `ECS_*`), so the agent's shell only inherits the Anthropic key and the proxy settings. That scrub does not reach the kernel's copy (`/proc/<pid>/environ` of the node process, readable by every worker since they share the `node` uid) — which is why the api reporter exchanges the bootstrap token first thing (`claim`) and the api revokes the token on the job's terminal write and on an admin kill. Still open: a worker with `ptrace` on the same uid could read the fresh token from the node process's memory; running worker sessions under a second uid closes that (noted in TODO-EXTERNAL). The task role can read the Anthropic key secret and put objects into the artifacts bucket — nothing else. The job never pushes anywhere (M5 adds delivery).

## Budget, kill switch, egress

- **Budget**: every planner/worker/merge message's usage is summed in one `BudgetTracker`; crossing `budget.maxTokens` (or `maxDurationMinutes`) aborts every in-flight session via a shared `AbortController` and the job ends `failed` with reason `budget exceeded`. `tokens_used` is persisted after every task and merge.
- **Kill switch**: `POST /bff/admin/jobs/:jobId/kill` sets `jobs.status = 'killed'` and calls `ecs:StopTask` when a task ARN is stored. The orchestrator also polls `GET /internal/jobs/:id` (`killed`) every 10 s and aborts itself, so a kill works even if StopTask lags; a status PATCH answered with `killed: true` short-circuits the next poll.
- **Egress allowlist**: `proxy/` builds a tinyproxy sidecar (`FilterDefaultDeny`, see `proxy/filter`: npm, GitHub, Anthropic). On Fargate it runs in the same task; the job container gets `HTTP_PROXY`/`HTTPS_PROXY` pointing at `localhost:8888`, `NO_PROXY` for the ECS credential endpoint, Secrets Manager, the artifacts bucket and the api host (the api appends its own host via the RunTask override, `JOB_NO_PROXY`), and the job security group allows only 443/80 out — no database rule. Note: Fargate sidecars share the task ENI, so the security group cannot distinguish proxy traffic from a process that ignores `HTTPS_PROXY`; a hard network fence needs a proxy in its own task/SG (see TODO-EXTERNAL.md). Locally, docker compose puts the job on an `internal` network where only the proxy has internet, which *is* a hard fence — that is where the allowlist is verified.

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
