# @mf/db

Postgres data layer on the porsager [`postgres`](https://github.com/porsager/postgres) driver.

- `createDb(connectionString, { max })` → `{ sql, query, close }` — `sql` is the tagged-template client, `query(text, params)` runs a positional-parameter query.
- `connectionStringFromSecret(secret)` builds the URL from the RDS-generated Secrets Manager JSON (`username`/`password`/`host`/`port`/`dbname`).
- `migrate(db)` applies `migrations/*.sql` in file order, one transaction per file, tracked in `schema_migrations`. Idempotent.
- Repositories (`src/repositories.ts` defines the interfaces, one file per table group implements them over a `Db`):
  - `jobs.ts` — `insertJob`, `getJob`, `listJobs`, `updateJob`, `appendEvent`, `listEvents(jobId, afterId)`; rows map to `Job` / `JobEvent`. A job row carries a copy of the frozen spec and the org id so the build container is self-contained.
  - `orders.ts` — an order row *is* the `SpecDraft` keyed by the (client-chosen, text) order id: `getOrder`, `listOrders` (newest first, max 200), `upsertOrder`, `updateOrderUnlessFrozen` (the spec chat's write: matches only a non-frozen row, so a freeze that landed during the engine call is never undone).
  - `users.ts` — `User` / `Org`: `getUser`, `findUserByEmail`, `insertUser`, `insertUserWithOrg` (org + first user in one transaction; `users.email` unique violation → `code: '23505'`, no orphan org), `getOrg`, `insertOrg`, `listOrgs`.
  - `auth.ts` — magic links and refresh tokens keyed by the sha256 of the token: `insertMagicLink`, `consumeMagicLink` (atomic single use), `countMagicLinksSince` (rate limit), `insertRefreshToken`, `consumeRefreshToken` (rotation), `revokeRefreshToken`, `pruneAuth` (exposed as `auth.prune()`; the api's `authService` runs it at boot and hourly — nothing else deletes rows from these tables).
- `createPostgresRepositories(db)` → `{ jobs, orders, users, auth }` bound to one pool.
- `createMemoryRepositories()` → the same interfaces over `Map`s. The api uses it when neither `DATABASE_URL` nor `DATABASE_SECRET_ARN` is set (local dev without docker) and in its tests, so the services are exercised against the same contract as Postgres — including the rules the SQL enforces (killed jobs are terminal, one active job per order rejects with `code: '23505'`, single-use links/tokens, one user per email, `orders.list` newest first capped at 200). Nothing survives a restart. Memory is used **only** when nothing is configured: a configured `DATABASE_SECRET_ARN` that cannot be read makes `app.db` unavailable (`/health` 503) rather than silently running on RAM.

## Migrations

| File | Contents |
|---|---|
| `0001_init.sql` | orgs, users, orders, jobs, job_events |
| `0002_jobs_task_arn.sql` | jobs: `order_id` → text, `org_id`, `spec`, `plan`, `reason`, `task_arn`, `max_workers`, `max_duration_minutes`, `updated_at` |
| `0003_jobs_one_active_per_order.sql` | partial unique index: one queued/planning/building/verifying job per order |
| `0004_orders_users_auth.sql` | orders carry the whole `SpecDraft` (`id` → text, `status` = spec status, `spec`, `messages`, `open_questions`, `size_class`, `price_sek`, `frozen_at`, org/user FKs dropped); new `magic_links` and `refresh_tokens` |

## Local development

```
docker compose up -d            # Postgres 17 on localhost:5432 (user/password/db: mf)
npm run db:migrate              # DATABASE_URL from root .env (postgres://mf:mf@localhost:5432/mf)
npm run db:seed                 # inserts a queued demo job with a tiny frozen spec, prints its id
npm run job:dev -- <id>         # runs the orchestrator locally against the same database
```

Set `DATABASE_URL` in the root `.env` and in `apps/api/.env.dev`. In AWS the api and the job task resolve `DATABASE_SECRET_ARN` instead (RDS in the `resources-<env>` stack). `psql` is not needed — the scripts use the node driver.
