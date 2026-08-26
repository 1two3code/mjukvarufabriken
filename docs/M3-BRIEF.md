# M3 brief — Orchestrator + sandbox

Working brief for milestone M3 in PLAN.md. Follow CLAUDE.md, templates/web/CLAUDE.md and `.claude/rules/` conventions (`@mf/*`, `.ts` import extensions, Zod 4, Vitest, tabs, conventional commits). Use the Edit/Write tools for source edits and `infra/scripts/deploy.sh dev` for deploys. Before writing Anthropic / Agent SDK code, load the `claude-api` skill.

## Existing state to build on

- `packages/harness` — M2 spec engine + placeholder `runJob` in `src/index.ts` with `JobSpec`/`JobBudget`/`JobStatus`/`JobResult`. Replace the placeholder with the real orchestrator.
- `packages/db` — stub `createDb`, no driver; `migrations/0001_init.sql` defines orgs/users/orders/jobs/job_events.
- `apps/api` — Fastify BFF, in-memory `store` plugin, `plugins/secrets.ts` (env or Secrets Manager), `plugins/anthropic.ts`, `services/specService.ts` with freeze (`frozenAt`, size, price), routes in `src/routes/bff/orders/spec`, auth in `plugins/auth.ts` (roles admin/user, admins via `AUTH_ADMIN_EMAILS`). Tests in `apps/api/test` — mirror `appMock.ts` patterns.
- `apps/portal` — React 19 SPA, sv+en, spec page at `/orders/:orderId/spec`. Mirror its feature/RTK Query/css-module structure.
- `infra/lib/resources-stack.ts` — cluster `mf-jobs-<env>`, `JobTaskDefinition` (placeholder `node:24-alpine` image, log group, task role reads `anthropic-api-key` + `github-token`, writes artifacts bucket), `JobSecurityGroup`, private NAT subnets. `web-stack.ts` already grants the api `ecs:RunTask/DescribeTasks/StopTask/ListTasks` on the cluster and passes subnets/SG. RDS Postgres 17 in private subnets with `DatabaseSecretArn`; api task already has env + SG access.
- `templates/web` is the golden template every customer build starts from — never edit in place.
- Root `.env` has `ANTHROPIC_API_KEY` and AWS creds (`node --env-file-if-exists=.env`, see root `spec:demo`). Docker 28 available locally; `psql` is not (use the node driver).

## Deliverables — the four M3 boxes

### 1. Job = container on Fargate, receives spec + budget, no customer secrets inside
- New workspace `apps/job` (`@mf/job`): entrypoint reads `JOB_ID` (+ `DATABASE_URL`/`DATABASE_SECRET_ARN`, `ANTHROPIC_API_KEY`/`ANTHROPIC_API_KEY_SECRET_ARN`), loads job + frozen spec from Postgres, runs `@mf/harness` `runJob`, writes status/tokens/events back. Dockerfile modelled on `apps/api/Dockerfile` (copies packages, apps/job and `templates/web`; the job seeds the working repo from the baked-in template, `git init`, commits). Nothing customer-specific baked in.
- Infra: `JobTaskDefinition` container → `ContainerImage.fromAsset` of the job Dockerfile (as the api does); env `DATABASE_SECRET_ARN`, `ANTHROPIC_API_KEY_SECRET_ARN`, `ARTIFACTS_BUCKET`, env name; task role reads the DB secret; DB SG ingress from the job SG. CDK synth stays green offline.
- Local runner: root `npm run job:dev -- <jobId>` runs the same entrypoint against `DATABASE_URL`. Root `docker-compose.yml` with Postgres 17; document in `packages/db/README.md`.

### 2. Plan → task DAG → parallel Agent SDK workers in git worktrees → merge
- `packages/harness/src/job/`: `planner.ts` (one structured Anthropic SDK call, model `PLAN_MODEL` default `claude-sonnet-5`, Zod-validated `Plan` = tasks with id, title, description, `dependsOn`, areas, acceptance-criteria ids), `dag.ts` (pure: acyclic check, ready-set/waves), `worker.ts` (one task = one `@anthropic-ai/claude-agent-sdk` `query()` session in its own `git worktree` on branch `task/<id>`, cwd-restricted, non-interactive permission mode suitable for the isolated container, tools Read/Edit/Write/Bash/Glob/Grep, system prompt with spec + task + repo conventions; worker runs the customer repo's `npm run lint` and `npm test` before declaring done), `merge.ts` (merge task branches into main in DAG order; one repair session on conflict; fail closed if still conflicting), `orchestrator.ts` (`runJob`: up to `maxWorkers` ready tasks concurrently, emits events, honours budget/kill). Export from `@mf/harness`.
- `Plan`/`Task`/`JobEvent` Zod schemas in `@mf/models`.
- Unit tests with fakes (no network): dag, scheduler ordering/concurrency, budget abort, kill, merge order, planner validation. Mirror `packages/harness/test`.

### 3. Hard token budget per job, kill switch, egress allowlist
- Budget: sum `usage` of every planner/worker/merge message; at `budget.maxTokens` abort all in-flight sessions (`AbortController`), job `failed`, reason `budget exceeded`. Enforce `maxDurationMinutes`. Persist `tokens_used` after every task.
- Kill switch: `POST /bff/admin/jobs/:jobId/kill` (admin) → `jobs.status='killed'` + `ecs:StopTask` when `task_arn` is stored (migration `0002_jobs_task_arn.sql`; add `plan jsonb`, `reason text` etc. as needed). The job polls its row every ~10 s and aborts if killed.
- Egress allowlist (npm, GitHub, Anthropic only): `egress-proxy` sidecar in the job task definition (tinyproxy or squid from a public registry, domain allowlist: `registry.npmjs.org`, `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `api.anthropic.com`; AWS Secrets Manager/S3 via `NO_PROXY` + VPC endpoints if simple — pick the simplest correct option and document it in comments). Main container gets `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`, `NODE_USE_ENV_PROXY=1`; job SG egress limited to 443/80 + Postgres to DB SG. Verify with docker compose (proxy + job) that an unlisted host is refused and npm/github/anthropic succeed.

### 4. Progress events streamed to DB (portal shows them live)
- `@mf/db`: `postgres` (porsager) driver; `createDb(connectionString)` → `{ sql, query, close }`; `migrate(db)` applies `migrations/*.sql` in order tracked in `schema_migrations`; root `npm run db:migrate`. Repositories: `insertJob`, `getJob`, `updateJob`, `appendEvent`, `listEvents(jobId, afterId)`.
- Api: `db` plugin (`DATABASE_URL` or `DATABASE_SECRET_ARN`, same pattern as secrets.ts); tests inject a fake and stay network-free. `jobService.startJob(orderId)` requires a frozen spec, inserts the job with budget by size class (S 2M / M 6M / L 15M tokens), then `ecs:RunTask` with `JOB_ID` env override via `@aws-sdk/client-ecs`; without ECS config it inserts the row and logs the `job:dev` command. Routes: `POST /bff/orders/:orderId/jobs`, `GET /bff/jobs/:jobId`, `GET /bff/jobs/:jobId/events?after=<id>` (org-scoped via the order), `POST /bff/admin/jobs/:jobId/kill`, `GET /bff/admin/jobs`. Tests for each.
- Portal: `/orders/:orderId/job` (sv+en): status, tokens used vs budget, live event log (RTK Query polling 3 s on `events?after=`), "Starta bygge / Start build" on the spec page once frozen; admins see a kill button.
- Job emits events: planned (with plan), task started/finished/failed (token counts), merge, verify, done/failed/killed.

## Verification — tick PLAN.md boxes only for what is actually verified
- `npm i`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke`, `cd infra && npx cdk synth` green.
- `docker compose up -d` → `npm run db:migrate` → seed org/user/order + frozen spec (`packages/db/scripts/seed-demo.ts` or via api) → `npm run job:dev -- <id>` with the live key on a tiny spec (e.g. "one-page sv/en site with a contact form, no backend"), `maxTokens` ≈ 400k, `maxWorkers` 2. Confirm: plan event, ≥2 tasks in parallel worktrees, merge, customer repo lint+test green, `tokens_used` recorded, events visible via `GET /bff/jobs/:id/events`. Record the real token cost.
- Build the job image locally; run the same job in docker compose behind the egress proxy; confirm `example.com` is blocked.
- Deploy dev with `infra/scripts/deploy.sh dev` (builds/pushes the job image), run one job on Fargate via the api, check status/events. Anything needing external approval (quotas etc.) → TODO-EXTERNAL.md, don't block.
- Update PLAN.md (M3 boxes, date 2026-08-26, short parenthetical), `packages/db/README.md`, `apps/job/README.md`, CLAUDE.md layout (add `apps/job`). Commit in logical conventional commits.

## Report back
What was built; what was verified with real numbers (test count, demo-job tokens, Fargate outcome); what is NOT verified and why; anything added to TODO-EXTERNAL.md.
