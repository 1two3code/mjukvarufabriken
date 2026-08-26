# @mf/db

Postgres data layer on the porsager [`postgres`](https://github.com/porsager/postgres) driver.

- `createDb(connectionString, { max })` → `{ sql, query, close }` — `sql` is the tagged-template client, `query(text, params)` runs a positional-parameter query.
- `connectionStringFromSecret(secret)` builds the URL from the RDS-generated Secrets Manager JSON (`username`/`password`/`host`/`port`/`dbname`).
- `migrate(db)` applies `migrations/*.sql` in file order, one transaction per file, tracked in `schema_migrations`. Idempotent.
- Job repository (`src/jobs.ts`): `insertJob`, `getJob`, `listJobs`, `updateJob`, `appendEvent`, `listEvents(jobId, afterId)`. Rows map to the `Job` / `JobEvent` models in `@mf/models`.

The api's in-memory `store` plugin still holds orders, specs and users (M6 moves them here); build jobs are the first tables that live in Postgres, so a job row carries a copy of the frozen spec and the org id.

## Migrations

| File | Contents |
|---|---|
| `0001_init.sql` | orgs, users, orders, jobs, job_events |
| `0002_jobs_task_arn.sql` | jobs: `order_id` → text, `org_id`, `spec`, `plan`, `reason`, `task_arn`, `max_workers`, `max_duration_minutes`, `updated_at` |

## Local development

```
docker compose up -d            # Postgres 17 on localhost:5432 (user/password/db: mf)
npm run db:migrate              # DATABASE_URL from root .env (postgres://mf:mf@localhost:5432/mf)
npm run db:seed                 # inserts a queued demo job with a tiny frozen spec, prints its id
npm run job:dev -- <id>         # runs the orchestrator locally against the same database
```

Set `DATABASE_URL` in the root `.env` and in `apps/api/.env.dev`. In AWS the api and the job task resolve `DATABASE_SECRET_ARN` instead (RDS in the `resources-<env>` stack). `psql` is not needed — the scripts use the node driver.
