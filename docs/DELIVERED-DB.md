# Delivered-app database provisioning (Gate C, audit finding D1)

Wave 12 / Gate C (strategy 2026-08-31 "Delivery-quality direction", item 2). Before this,
`envManifest` could *detect* that a built app required `DATABASE_URL`, but nothing ever
provisioned one: the app booted (lazy DB clients connect on first query), served its SPA, passed
wiredSmoke (500 ≠ 404) and shipped a live URL whose every read/write 500'd against a database
that never existed — the most likely broken-ship for the SMB persistence-app strategy.

## Design

**Who holds which credential** is the whole design:

- The **api** already holds the platform Postgres credentials (`DATABASE_URL` /
  `DATABASE_SECRET_ARN`, the RDS master secret in the deployed envs). Provisioning lives there,
  in `apps/api/src/services/previewDbService.ts`.
- The **build job** never regains database credentials (M3 hardening #18 stands). It calls
  `POST /internal/jobs/:jobId/database` with its per-job report token — the same auth as every
  other report call — and receives back ONLY the scoped connection string for its own delivered
  app. That URL goes into the delivery env manifest, the pre-deploy boot smoke, and the ECS
  Express container env.
- The **delivered app** gets a LOGIN-only role (`NOSUPERUSER NOCREATEDB NOCREATEROLE`,
  connection-limited) that owns exactly one database, `mf_app_<jobid16>`. `REVOKE CONNECT ON
  DATABASE … FROM PUBLIC` closes Postgres' default any-role-may-connect grant, so one delivered
  app's role cannot reach another's database.

**Naming / idempotency**: database and role are both `mf_app_<first 16 [a-z0-9] of the job id>`
— deterministic, so a redelivery reuses (and re-keys: fresh password, `ALTER ROLE … PASSWORD`)
the same database instead of leaking one per attempt. Identifiers are strictly `[a-z0-9_]` and
passwords base64url, so the interpolated DDL cannot carry SQL; every user-shaped value stays
parameterised. `GRANT <role> TO CURRENT_USER` before `CREATE DATABASE … OWNER` is the RDS
non-superuser-master dance.

**When it triggers** (`packages/harness/src/job/delivery/envManifest.ts#detectDatabaseNeed`,
called from `deliver.ts`): `DATABASE_URL` in the app's declared required env, a known DB client
(`pg`, `postgres`, `drizzle-orm`, `knex`, `@prisma/client`, `typeorm`, `kysely`) in any
package.json dependencies, or a `migrations/` directory. Detection errs wide — a false positive
costs one empty database; a false negative ships a dead app.

Since 2026-09-02 (dogfood run 6, docs/LEARNINGS.md) the template's own `store` plugin is
Postgres-backed whenever `DATABASE_URL` is set, and `postgres` is a template dependency — so
every template-derived app trips the dependency signal and gets a database. That is intended:
the alternative (a worker replacing an in-memory `Map` with a real client on its own) is the
trap run 6 fell into.

**Fail closed**: when the app needs a database and the provisioner is missing (local db-mode
runs) or errors, the deploy is *skipped* with the reason on the `deploy` step — a repo + bundle
still deliver, but no live-but-dead URL is handed out. This mirrors the C1 recommendation from
the audit (block, don't degrade silently).

**Config** (api): `PREVIEW_DB_ADMIN_URL` overrides the admin connection (default: the platform
database connection); `PREVIEW_DB_HOST` (`host[:port]`) overrides the host written into the URL
handed to delivered containers (e.g. local docker vs. in-VPC hostname). Remote URLs carry
`sslmode=no-verify` (encrypted, unverified — delivered apps ship no CA bundle; same trade-off
as @mf/db's `require` mode).

## Deliberately left out (and why)

- **Migrations are not run by the platform.** The delivered app owns its schema; the template
  convention (api runs `migrate()` at boot) means a delivered app that follows it self-migrates
  on first boot against its provisioned database. A worker-conventions nudge ("run your
  migrations at boot") would change the session system prompt and thus the replay cassette —
  deferred to a prompt-touching wave.
- **No separate RDS instance / per-app server.** One platform server, fenced by role +
  database + revoked PUBLIC connect, is the honest minimum. A dedicated delivered-apps instance
  is an infra decision (cost) for later; the service already takes `PREVIEW_DB_ADMIN_URL` so
  pointing it elsewhere needs no code change.
- **Teardown of provisioned databases** — `DROP DATABASE`/`DROP ROLE` on order teardown —
  belongs with the existing teardown path (deployed_services recording); noted there rather than
  half-built here.
- **Network reachability** (delivered ECS Express tasks → RDS security group, and the build
  job's boot smoke → RDS through the egress fence) is environment wiring, not code; until the
  SG rule lands, the live acceptance check fails closed on the 5xx it would cause, which is the
  designed behaviour. Operator step, tracked in TODO-EXTERNAL.md.
- **Revoking PUBLIC connect on the PLATFORM database** (so delivered roles cannot even attempt
  it — they'd still fail auth-side table grants, but belt-and-braces): a one-time operator
  statement, listed in TODO-EXTERNAL.md, not run automatically against the production database
  by a code path.
