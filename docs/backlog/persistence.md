# Stream: persistence — orders, specs, users and auth in Postgres

Areas: `packages/db`, `apps/api` (plugins `store`/`db`, services `specService`, `userService`,
`authService`, their tests). Do not touch harness, job, portal, site, infra.

## Problem
The api keeps specs/orders, users, orgs, magic links and refresh tokens in the in-memory `store`
plugin. Every api deploy wipes them (tonight three dev deploys lost frozen specs and logins).
Jobs and job events already live in Postgres through `@mf/db` (`apps/api/src/plugins/db.ts`,
`packages/db/src/jobs.ts`) — extend that pattern.

## Deliverables
1. Migration `packages/db/migrations/0004_orders_users_auth.sql`: make `orders` carry the full
   `SpecDraft` (status, messages jsonb, spec jsonb, size_class, price_sek, frozen_at, org_id,
   created_by), add `magic_links` (token_hash pk, email, expires_at, used_at, created_at) and
   `refresh_tokens` (token_hash pk, user_id, expires_at, revoked_at, created_at). `orgs`/`users`
   exist in 0001 — adjust columns if the models need it (e.g. users.role, orgs.domain), with
   `alter table` statements, never by editing 0001.
2. Repositories in `packages/db/src/`: `orders.ts`, `users.ts` (users + orgs), `auth.ts` (magic
   links + refresh tokens), typed against `@mf/models`, same style as `jobs.ts` (uuid guards,
   `updated_at`, parameterised sql). Unit tests for pure helpers; SQL is exercised by the api
   tests through the in-memory implementation below.
3. `@mf/db` also exports an **in-memory implementation** of the same repository interfaces
   (`createMemoryRepositories()`), used by the api when `DATABASE_URL`/`DATABASE_SECRET_ARN` is
   absent (local dev without docker) and by the api tests. This replaces the generic `store`
   plugin: delete `apps/api/src/plugins/store.ts` and its test once nothing uses it (the `items`
   demo may keep a tiny in-memory map inside `itemService`).
4. `apps/api/src/plugins/db.ts` decorates `app.db` with `{ available, jobs, orders, users, auth }`
   — Postgres-backed when configured, memory-backed otherwise, and logs which one at boot.
   Services use `app.db.*` only.
5. Org scoping stays as it is after the M3 review (spec/job access checks `orgId`).
6. Docs: `packages/db/README.md` (tables, memory fallback), `apps/api/README.md` if present.

## Verification
- `npm run lint`, `npm test` (api tests must stay network-free through the memory repositories),
  `npm run build`.
- Against local docker compose Postgres (`docker compose up -d postgres`, `npm run db:migrate`):
  start the api with `DATABASE_URL` set, request a magic link (log transport prints it), verify,
  create a spec via `POST /bff/orders/:id/spec` with `ANTHROPIC_API_KEY` from root `.env`,
  restart the api, confirm the session refresh and the spec survive. Record the steps in the
  report. Do not stop or reset the compose database; other work may be using it.
- PLAN.md: update the M2 "in-memory store" and M6 auth notes to say Postgres; no new boxes.
