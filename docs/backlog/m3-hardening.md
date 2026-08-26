# Stream: m3-hardening — job reports through the api, not the RDS master secret

Areas: `apps/job` (reporting client), `apps/api` (`routes/bff/jobs/internal/*` or
`routes/internal/*`, `services/jobService.ts` ingestion, `plugins/ecs.ts` token injection),
`packages/db` ONLY `jobs.ts` additions, `infra` (remove DB secret grant + job↔DB SG rule, add
api URL env to the job task, api ALB reachable from the job SG). See docs/M3-REVIEW.md #18.

## Deliverables
1. Per-job bearer token: `jobService.start` mints a random 32-byte token, stores its sha256 on the
   job row (`0007_jobs_report_token.sql`), and injects `JOB_TOKEN` + `API_URL` via the RunTask
   container override (never logged).
2. Api internal routes (auth = job token for that jobId only, no session): `GET /internal/jobs/:id`
   (spec + budget + kill flag), `POST /internal/jobs/:id/events` (batch), `PATCH /internal/jobs/:id`
   (status/tokens/plan/gates/urls with the killed-guard), each validated with Zod and covered by
   tests (wrong token → 401, other job's token → 404).
3. `apps/job` uses an `JobReporter` interface: `api` implementation (fetch to `API_URL` through
   `NO_PROXY` — the api hostname must be added to the job's `NO_PROXY` and allowed by the SG),
   `db` implementation kept for `npm run job:dev` locally. Kill polling goes through the api.
4. Infra: drop `DATABASE_SECRET_ARN` + the secret grant + the job→DB security-group rule; add
   the api's internal URL (the ALB DNS from `mf-<env>` — mind cross-stack references; if it
   creates a cycle, pass the URL via SSM parameter written by `mf-<env>` and read at job start).
5. The `notify` job events from the M4 gates are forwarded by the api to `AUTH_ADMIN_EMAILS`
   through the `email` plugin on ingestion.
6. Update docs/M3-REVIEW.md #18 status, `apps/job/README.md`, PLAN.md hardening item.

## Verification
- `npm run lint`, `npm test`, `npm run build`, `cd infra && npx cdk synth` (+ `cdk diff` pasted
  trimmed into the report). No deploy.
