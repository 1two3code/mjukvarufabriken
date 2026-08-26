# @mf/job — build-job container

One container = one job. The entrypoint (`src/index.ts`) reads `JOB_ID`, loads the job row and its frozen spec from Postgres (`@mf/db`), seeds `/work/repo` from the golden template baked into the image (`templates/web`, `git init`, one commit), then runs the `@mf/harness` orchestrator and writes status, `tokens_used` and events back. Same code path locally and on Fargate.

```
plan (Anthropic SDK, PLAN_MODEL)          → job_events: planned {plan}
  └─ ready tasks × maxWorkers in parallel  → task_started / task_finished / task_failed
       each: git worktree task/<id> → Agent SDK query() → npm run lint + npm test → commit
  └─ merge each finished branch into main  → merge {ok}
       (one repair session on conflict, fail closed otherwise)
  └─ final npm run lint + npm test on main → verify → done | failed | killed
```

## Configuration (env)

| Variable | Purpose |
|---|---|
| `JOB_ID` (or argv) | Job to run — set by the api's `ecs:RunTask` override or `npm run job:dev -- <id>` |
| `DATABASE_URL` / `DATABASE_SECRET_ARN` | Postgres; the ARN is the RDS-generated secret, resolved at startup |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY_SECRET_ARN` | Model access for planner + workers |
| `PLAN_MODEL`, `WORKER_MODEL` | Model overrides (default `claude-sonnet-5`) |
| `WORK_DIR`, `TEMPLATE_DIR` | `/work` and `/usr/src/templates/web` in the image |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY=1` | Egress through the allowlist sidecar |

No customer secrets are passed in: the container only sees the job id, the database and the Anthropic key. The job never pushes anywhere (M5 adds delivery).

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
