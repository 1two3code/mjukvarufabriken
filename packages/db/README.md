# @mf/db

Postgres data layer on the porsager [`postgres`](https://github.com/porsager/postgres) driver.

- `createDb(connectionString, { max })` → `{ sql, query, close }` — `sql` is the tagged-template client, `query(text, params)` runs a positional-parameter query.
- `connectionStringFromSecret(secret)` builds the URL from the RDS-generated Secrets Manager JSON (`username`/`password`/`host`/`port`/`dbname`).
- `migrate(db)` applies `migrations/*.sql` in file order, one transaction per file, tracked in `schema_migrations`. Idempotent.
- Repositories (`src/repositories.ts` defines the interfaces, one file per table group implements them over a `Db`):
  - `jobs.ts` — `insertJob`, `getJob`, `listJobs`, `updateJob`, `appendEvent`, `listEvents(jobId, afterId)`; rows map to `Job` / `JobEvent`. A job row carries a copy of the frozen spec and the org id so the build container is self-contained.
  - `orders.ts` — an order row *is* the `SpecDraft` keyed by the (client-chosen, text) order id: `getOrder`, `listOrders` (newest first, max 200), `upsertOrder`, `updateOrderUnlessFrozen` (the spec chat's write: matches only a non-frozen row, so a freeze that landed during the engine call is never undone).
  - `users.ts` — `User` / `Org`: `getUser`, `findUserByEmail`, `insertUser`, `insertUserWithOrg` (org + first user in one transaction; `users.email` unique violation → `code: '23505'`, no orphan org), `getOrg`, `insertOrg`, `listOrgs`.
  - `auth.ts` — magic links and refresh tokens keyed by the sha256 of the token: `insertMagicLink`, `consumeMagicLink` (atomic single use), `countMagicLinksSince` (rate limit), `insertRefreshToken`, `consumeRefreshToken` (rotation), `revokeRefreshToken`, `pruneAuth` (exposed as `auth.pruneExpired()`; the api's `pruner` plugin schedules it through `lib/housekeeping.ts` — shortly after boot, then hourly with jitter, Postgres only — nothing else deletes rows from these tables).
  - `rateLimits.ts` — one row per counted hit in `rate_limits` (`scope`, `key`, `hit_at`): `count(scope, key | undefined, since)` (per key or across the scope), `record(scope, key, at)`, `pruneExpired()` (drops hits older than `rateLimitRetentionMs`; the api's `pruner` plugin schedules it the same way as `pruneAuth`, so rows are only ever deleted by that hourly prune). Limiters compute their `since` with `rateLimitWindowStart(windowMs, now)`, which throws if a window would outlast the retention the pruner keeps. The api's contact-form limiter lives here so all api tasks share the counts; the magic-link limiter still counts `magic_links` rows.
- `createPostgresRepositories(db)` → `{ jobs, orders, users, auth, rateLimits }` bound to one pool.
- `createMemoryRepositories()` → the same interfaces over `Map`s. The api uses it when neither `DATABASE_URL` nor `DATABASE_SECRET_ARN` is set (local dev without docker) and in its tests, so the services are exercised against the same contract as Postgres — including the rules the SQL enforces (killed jobs are terminal, one active job per order rejects with `code: '23505'`, single-use links/tokens, one user per email, `orders.list` newest first capped at 200). The memory `auth` and `rateLimits` repositories sweep expired rows themselves on insert (at most once a minute; `rateLimits` also caps the tracked keys), since the api's housekeeping only runs on Postgres. Nothing survives a restart. Memory is used **only** when nothing is configured: a configured `DATABASE_SECRET_ARN` that cannot be read makes `app.db` unavailable (`/health` 503) rather than silently running on RAM.

## Migrations

| File | Contents |
|---|---|
| `0001_init.sql` | orgs, users, orders, jobs, job_events |
| `0002_jobs_task_arn.sql` | jobs: `order_id` → text, `org_id`, `spec`, `plan`, `reason`, `task_arn`, `max_workers`, `max_duration_minutes`, `updated_at` |
| `0003_jobs_one_active_per_order.sql` | partial unique index: one queued/planning/building/verifying job per order |
| `0004_orders_users_auth.sql` | orders carry the whole `SpecDraft` (`id` → text, `status` = spec status, `spec`, `messages`, `open_questions`, `size_class`, `price_sek`, `frozen_at`, org/user FKs dropped); new `magic_links` and `refresh_tokens` |
| `0005_jobs_gates.sql` … `0008_job_events_seq.sql` | job gates, order payments, job report token, numbered job events (waves 1–3) |
| `0010_rate_limits.sql` | `rate_limits` (`scope`, `key`, `hit_at`, indexed on `(scope, hit_at)` and `(scope, key, hit_at)`) — shared counters for the api's rate limiters |

## Local development

```
docker compose up -d            # Postgres 17 on localhost:5432 (user/password/db: mf)
npm run db:migrate              # DATABASE_URL from root .env (postgres://mf:mf@localhost:5432/mf)
npm run db:seed                 # inserts a queued demo job with a tiny frozen spec, prints its id
npm run job:dev -- <id>         # runs the orchestrator locally against the same database
```

Set `DATABASE_URL` in the root `.env` and in `apps/api/.env.dev`. In AWS the api and the job task resolve `DATABASE_SECRET_ARN` instead (RDS in the `resources-<env>` stack).

TLS (`sslMode`): local hosts (`localhost`, `127.0.0.1`, `postgres`) connect in plaintext; `*.rds.amazonaws.com` hosts use `verify-full` — certificate chain and host name checked against the RDS global CA bundle the api/job images bake in at `/etc/ssl/certs/rds-global-bundle.pem` (`NODE_EXTRA_CA_CERTS`); any other remote host gets `require` (encrypted, unverified). `DATABASE_SSL=disable|require|verify-full` overrides — use `require` when reaching RDS from a machine without the bundle. `psql` is not needed — the scripts use the node driver.
