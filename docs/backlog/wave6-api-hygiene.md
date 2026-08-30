# Stream: api-hygiene-2 — scheduled pruning, db-backed limits, CI for infra/resident

Areas: `apps/api` (services/plugins for pruning + rate limits), `packages/db` (a prune query +
migration only if needed), `.github/workflows/ci.yml`. Do NOT touch harness/job/portal/site.

## Context (from the wave-4/5 "unfinished" notes)
- `pruneAuth` exists in the auth repository but nothing calls it on a schedule.
- The magic-link and contact rate limiters were moved to db repositories in wave 4, but expired
  rate-limit rows are never pruned; and the memory backend doesn't prune at all (fine).
- `.github/workflows/ci.yml` does not install/synth/test `infra/resident`.
- `specService.get` may still auto-create a draft for an unknown order id (orders are created via
  `POST /bff/orders`); confirm and guard (unknown id → 404) if not already fixed.

## Deliverables
1. A background pruner in the api (a `setInterval` with jitter, hourly, Postgres-only, started in a
   plugin and cleared on close): prunes expired `magic_links`, revoked/expired `refresh_tokens`, and
   expired rate-limit rows. One `pruneExpired()` per repository; a small `pruner` plugin calls them.
   Log a one-line summary per run. No-op on the memory backend.
2. Confirm `specService.get` does not auto-create for unknown ids; add the 404 guard + test if
   missing. Keep org-scoping intact.
3. `.github/workflows/ci.yml`: add a step (or matrix leg) that runs `npm ci --prefix infra/resident`
   + `npx cdk synth --quiet` + `npm test` in `infra/resident`; keep the existing `npm audit`
   allow-fail step.
4. Tests for the pruners (fake clock / injected now), the 404 guard, and any new query.

## Verify
`npm run lint`, `npm test` (network-free via the memory repositories), `npm run build`,
`cd infra && npx cdk synth`. Commit in conventional commits. No deploy.
