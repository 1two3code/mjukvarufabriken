# mjukvaruhuset.se — one-shot software road

Brand: **Mjukvaruhuset** (mjukvaruhuset.se, decided 2026-08-26; repo folder name is historical).

Goal: a customer submits a spec, the factory builds it, delivers repo + running URL, customer pays.
Everything that needs someone else's approval lives in TODO-EXTERNAL.md and is NOT on this road.

## Decisions (made 2026-08-26, change here if you disagree)
- Cloud: AWS (CDK for IaC, eu-north-1 Stockholm)
- Agent runtime: Claude Agent SDK (TypeScript), build jobs in Docker on ECS Fargate
- Payment: Stripe Checkout (Klarna/cards come through Stripe). Test mode until live verification clears.
- Stack: `templates/web` — npm-workspaces TS monorepo extracted clean-room from uptool-pwa: React 19 + Vite + RTK Query SPA, Fastify 5 BFF (Zod 4), CDK. Used for the factory portal/site AND as the golden template every customer build starts from. Postgres (RDS), S3 for artifacts
- Auth: email magic link (BankID = later)
- Delivery target: GitHub repo — we create a GitHub org/account for the customer during onboarding if they lack one, then transfer (decided 2026-08-26) + deploy to AWS App Runner with URL
- Languages: sv + en on both the public site and the portal from v1 (decided 2026-08-26)
- Pricing v1: S/M/L = 15k / 45k / 120k SEK ex moms (decided 2026-08-26); fixed price per accepted spec, 50% deposit before build, 50% on delivery; resident-agent mode = tokens × 1.5 + monthly fee. Resident agent v1 runs on the customer's own Anthropic key once deployed in their account (decided 2026-08-26)

## You must provide before build starts (hours, not weeks)
- [x] AWS account, IAM user `hasse` in root `.env` (verified via STS 2026-08-26) — billing alert: confirm
- [x] Anthropic API key in root `.env` as `ANTHROPIC_API_KEY` (2026-08-26)
- [ ] GitHub org `mjukvaruhuset` + token with repo/admin scope
- [ ] Stripe account (test-mode keys are enough to build)
- [x] Domain: mjukvaruhuset.se registered via Route 53 Domains (exp. 2027-08-26), hosted zone + NS delegation in place — verified 2026-08-26
- [x] Answers to open questions at the bottom of this file (2026-08-26, folded into Decisions)

## Milestones (checkbox = done and verified)

### M1 — Skeleton (day 1)
- [x] `templates/web` extracted and green (lint + test) — 2026-08-26
- [x] Monorepo: `apps/site`, `apps/portal` (instantiated from templates/web), `packages/harness`, `packages/db`, `infra/` — 2026-08-26 (8 workspaces, lint + 68 tests + build green)
- [x] CI (GitHub Actions): lint, test, build — 2026-08-26 (`ci.yml` lint/coverage/build/synth, `deploy.yml` OIDC dev→live; runs on first push to GitHub)
- [x] CDK stack: VPC, RDS, S3, ECS cluster, App Runner, secrets — 2026-08-26 (VPC 1 NAT, RDS Postgres 17 t4g.micro/small, artifacts bucket, 4 Secrets Manager placeholders, ECS cluster `mf-jobs-<env>` + Fargate job task def, api wired with env + IAM + SG to RDS; 4 stacks synth offline. App Runner deferred to M5: created per customer job at runtime, not in our stack)
- [x] TOKENS.md ledger started — 2026-08-26

### M2 — Spec engine
- [x] Spec chat → structured spec (JSON schema: goal, users, features, non-goals, acceptance criteria, stack constraints) — 2026-08-26 (`SpecSchema` in @mf/models; `@mf/harness` spec engine = one forced strict tool call per turn, model `claude-sonnet-5` via `SPEC_MODEL`; api `/bff/orders/:orderId/spec`; portal `/orders/:orderId/spec`)
- [x] Clarification loop: agent asks questions until spec passes a completeness check — 2026-08-26 (`isSpecComplete` deterministic; unit tests drive question → answer → complete with a fake client. Live-model behaviour UNVERIFIED until `ANTHROPIC_API_KEY` is set — run `npm run spec:demo`)
- [x] Price estimator from spec (size class S/M/L → fixed price) — 2026-08-26 (`priceEstimator.ts`, keyword rules sv+en, 10 unit tests)
- [x] Spec frozen + signed off in portal before build — 2026-08-26 (freeze route requires completeness, fixes size + price + `frozenAt`; portal confirm dialog; drafts persisted in Postgres `orders` since 2026-08-27 — `packages/db/migrations/0004`, in-memory fallback without `DATABASE_URL`)

### M3 — Orchestrator + sandbox
- [ ] Job = container on Fargate, receives spec + budget, no customer secrets inside — code + image + infra deployed to dev 2026-08-26 (`apps/job`, job image + egress-proxy sidecar in `resources-dev`), but NO Fargate run through the api yet — run `scratchpad/dev-e2e.sh` flow or `POST /bff/orders/:id/jobs` on dev to verify
- [ ] Plan → task DAG → parallel Agent SDK workers in git worktrees → merge — code done + 30 unit tests 2026-08-26, LIVE RUN NOT VERIFIED: 4 local demo jobs, planner works (3 tasks in ~20 s) but every run died in the first worker task — #1–#3 blew a 400k budget in ~3 min (tokens 411k/426k/400k), #4 (2M budget) was interrupted at 3.6k tokens. Next: rerun #4-style job to completion, then investigate worker token burn (likely lint/test loops + full-context turns) (`@mf/harness` job/: planner = one strict tool call `PLAN_MODEL` claude-sonnet-5, Zod `Plan`/`Task` in @mf/models, pure dag.ts, worker = Agent SDK `query()` per task in `git worktree` task/<id> with hard-linked node_modules + lint/test gate + one repair session, merge in DAG order with one conflict-repair session then fail closed; 30 unit tests with fakes)
- [x] Hard token budget per job, kill switch, egress allowlist (npm, github, anthropic only) — 2026-08-26 (`BudgetTracker`: every message's usage summed, cache reads at 10 %, first breach aborts all sessions via shared AbortController, `maxDurationMinutes` too; `POST /bff/admin/jobs/:id/kill` → status killed + ecs:StopTask, job polls its row every 10 s; tinyproxy sidecar `apps/job/proxy` with FilterDefaultDeny — verified in docker compose: example.com blocked, npm/GitHub/Anthropic pass, no direct route)
- [x] Progress events streamed to DB (portal shows them live) — 2026-08-26 (`@mf/db` postgres driver + `migrate` + job repositories, `0002_jobs_task_arn`; api `db`/`ecs` plugins + `jobService` + 6 routes, 30 api tests; portal `/orders/:orderId/job` polls `events?after=` every 3 s, Start build on frozen spec, admin kill button)

### M4 — QA gates
- [ ] M3 hardening: the job reports status/events/usage to the api over an authenticated per-job endpoint instead of holding the RDS master secret (remove `DATABASE_SECRET_ARN` grant + job↔DB SG rule; docs/M3-REVIEW.md #18)
- [ ] Tests generated from acceptance criteria and must pass
- [ ] Independent review agent (correctness + security), findings must be fixed or waived
- [ ] Acceptance-check agent: every criterion mapped to evidence
- [ ] Job fails closed: no green gates → no delivery, human notified

### M5 — Delivery
- [ ] GitHub repo created, README + handover doc, transferred to customer
- [ ] Deployed to App Runner, URL in portal
- [ ] Deliverable bundle in S3 (repo zip, docs, test report)

### M6 — Portal + payment
- [x] Magic-link auth, org/user model — 2026-08-26, login verified end-to-end on dev by Hasse (pulled forward; users/orgs/magic links/refresh tokens persisted in Postgres since 2026-08-27 — `0004_orders_users_auth.sql`, in-memory fallback without `DATABASE_URL`. Api is its own EdDSA token issuer: `/bff/auth/{magic-link,verify,refresh,logout}`, `/.well-known/jwks.json`; `User`/`Org` models, org named after email domain, admins via `AUTH_ADMIN_EMAILS`; portal email form → `/auth/callback`; infra: `auth-jwt-private-key` secret, SES identity + DKIM, dev uses the `log` email transport until SES production access)
- [ ] Sign in with GitHub (decided 2026-08-26): OAuth App → `/bff/auth/github` + callback issuing the same EdDSA session tokens, `githubId`/`githubLogin` on `User`, account linking by verified email; magic link stays as fallback. Doubles as the customer's GitHub identity for M5 repo transfer. Same plugin shape later for Google / BankID. Needs the OAuth App client id/secret (TODO-EXTERNAL)
- [ ] Order flow: new order → spec chat → freeze → Stripe deposit → build → deliver → Stripe balance
- [ ] Live job progress, deliverables, invoices (Stripe-hosted), token usage
- [ ] Admin view: all jobs, budgets, kill switch

### M7 — Public site
- [ ] Landing, how it works, pricing, contact — sv/en
- [ ] Built THROUGH the harness (first case study)

### M8 — Resident agent mode
- [ ] Deploy agent into customer's AWS account (CDK template) with scoped IAM + customer's own Anthropic key or metered via ours
- [ ] Monthly token cap, pause button, audit log of every action
- [ ] Metering → Stripe usage-based billing

### M9 — Ops
- [ ] Logs + alerts: token burn per job, failed jobs, cost anomalies
- [ ] Backups (RDS automated), incident runbook
- [ ] Security baseline: secrets in Secrets Manager, least-privilege IAM, dependency scanning
- [ ] RDS TLS `verify-full` by default with the RDS CA bundle in the api/job images (`DATABASE_SSL`, docs/M3-REVIEW.md #12)

### M10 — Proof
- [ ] Dogfood: 3 internal apps built end-to-end from spec, results logged in TOKENS.md
- [ ] Pilot-ready: contract drafts in `legal/` (unreviewed until TODO-EXTERNAL clears)

## Open questions (answer inline)
1. Company/brand name on site while AB is pending — "Mjukvaruhuset" as trade name OK?
  - Turns out "mjukvaruhuset.se" was free so I just poached that instead.
2. Price points for S/M/L? (proposal: 15k / 45k / 120k SEK ex moms)
  - Sure
3. Which repo host for customers who don't have GitHub — zip only, or also GitLab?
  - I think we should setup github for them as part of the on boarding right?
4. Resident agent v1: customer's own Anthropic key (simplest, no metering risk) or ours (margin)? Proposal: theirs in v1.
  - Customers own once it's all deployed. So yeah basically your proposal if I understood you
5. Portal in Swedish too in v1, or en only?
  - Swedish too definitely.
- 
