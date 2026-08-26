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
- [x] Job = container on Fargate, receives spec + budget, no customer secrets inside — 2026-08-26 (`apps/job` image runs as `node` with the egress-proxy sidecar; api `POST /bff/orders/:id/jobs` → `ecs:RunTask`; verified on dev: jobs 266a218a and a552a1ad planned + built 3–4 tasks each (2 in parallel), 2.5M budget-tokens ≈ USD 6.5, 44 min; events/status streamed to RDS over TLS and shown in the portal; both runs failed closed at the final step on real defects since fixed — deps sync after merge, husky hooks)
- [ ] Plan → task DAG → parallel Agent SDK workers in git worktrees → merge — code done + 30 unit tests 2026-08-26, LIVE RUN NOT VERIFIED: 4 local demo jobs, planner works (3 tasks in ~20 s) but every run died in the first worker task — #1–#3 blew a 400k budget in ~3 min (tokens 411k/426k/400k), #4 (2M budget) was interrupted at 3.6k tokens. Next: rerun #4-style job to completion, then investigate worker token burn (likely lint/test loops + full-context turns) (`@mf/harness` job/: planner = one strict tool call `PLAN_MODEL` claude-sonnet-5, Zod `Plan`/`Task` in @mf/models, pure dag.ts, worker = Agent SDK `query()` per task in `git worktree` task/<id> with hard-linked node_modules + lint/test gate + one repair session, merge in DAG order with one conflict-repair session then fail closed; 30 unit tests with fakes)
- [x] Hard token budget per job, kill switch, egress allowlist (npm, github, anthropic only) — 2026-08-26 (`BudgetTracker`: every message's usage summed, cache reads at 10 %, first breach aborts all sessions via shared AbortController, `maxDurationMinutes` too; `POST /bff/admin/jobs/:id/kill` → status killed + ecs:StopTask, job polls its row every 10 s; tinyproxy sidecar `apps/job/proxy` with FilterDefaultDeny — verified in docker compose: example.com blocked, npm/GitHub/Anthropic pass, no direct route)
- [x] Progress events streamed to DB (portal shows them live) — 2026-08-26 (`@mf/db` postgres driver + `migrate` + job repositories, `0002_jobs_task_arn`; api `db`/`ecs` plugins + `jobService` + 6 routes, 30 api tests; portal `/orders/:orderId/job` polls `events?after=` every 3 s, Start build on frozen spec, admin kill button)

### M4 — QA gates
- [ ] M3 hardening: the job reports status/events/usage to the api over an authenticated per-job endpoint instead of holding the RDS master secret (remove `DATABASE_SECRET_ARN` grant + job↔DB SG rule; docs/M3-REVIEW.md #18). Same endpoint closes the M9-review gaps: per-job artifact uploads (today `s3:PutObject` is bucket-wide, a job can overwrite another's zip) and tamper-proof job events (today the `jobs-failed` / `job-token-burn` alarms read log lines the customer's build scripts can also print) — 2026-08-26 wave 2 `m3-hardening`: per-job token + `/internal/jobs/:id` (get / events / patch), `JobReporter` in apps/job (`api` on Fargate, `db` for `job:dev`), DB grant + 5432 rules removed, `notify` → admin email, `gate` → `jobs.gates`; unit- and synth-verified, live run pending. Review fixes (same day): one-shot bootstrap token exchange (`POST /internal/jobs/:id/token`), token revoked on terminal write / kill, forward-only status, idempotent numbered events (`0008_job_events_seq.sql`), validated gate payloads, notify caps, reason truncation. Still open: per-job artifact uploads (M5), alarms on events instead of log lines (M9), second uid for worker sessions and a live `domain` for TLS reports (TODO-EXTERNAL).
- [x] Tests generated from acceptance criteria and must pass — 2026-08-26, unit-verified, live run pending (`acceptance-tests` gate: one `<id>.test.ts[x]` per criterion, one fix session on app code only)
- [x] Independent review agent (correctness + security), findings must be fixed or waived — 2026-08-26, unit-verified, live run pending (read-only session → strict `ReviewFinding[]`, one fix + re-review, `jobs.gate_waivers`)
- [x] Acceptance-check agent: every criterion mapped to evidence — 2026-08-26, unit-verified, live run pending (`AcceptanceReport`, any unmet/unknown fails)
- [x] Job fails closed: no green gates → no delivery, human notified — 2026-08-26, unit-verified, live run pending (`GateReport` per gate as `gate` event, `notify` event to admins; api forwarding + `jobs.gates` persistence pending m3-hardening/persistence). Live check: `npm run gates:demo -- --repo <built repo> --spec <json>`

### M5 — Delivery
- [x] GitHub repo created, README + handover doc, transferred to customer — 2026-08-27, code + dry-run verified; live delivery pending GitHub org / token (TODO-EXTERNAL). `@mf/harness` `src/job/delivery/`: `deliver()` runs docs → repo → deploy → bundle after green gates, one `delivery` event per step; HANDOVER.md / TEST-REPORT.md / README.md / apprunner.yaml generated (tables deterministic from `GateReport`/`AcceptanceReport`, prose from one read-only Agent SDK session with the spec goal as fallback) and committed; private repo `mjukvaruhuset/<app>-<job prefix>` via Octokit behind a `GitHubClient` interface (fake + `--dry-run`), main force-pushed with the token only in the push argument, customer added as admin when the order carries `customerGithubLogin` (M6) else `transferPending`; `repositoryUrl` on the job row. Tests: `test/job/delivery/*` (19) + orchestrator delivery cases; `npm run delivery:demo -- --repo <dir> --dry-run`
- [x] Deployed to App Runner, URL in portal — 2026-08-27, code + dry-run verified; live deploy pending the App Runner GitHub connection (TODO-EXTERNAL). Source deployment of the api from the pushed repo (`apprunner.yaml`, Node 22 + type stripping — v1 limitation, the customer's own `infra/` CDK is the real deploy) through `@aws-sdk/client-apprunner` behind a `DeployClient`; deploy failure → still `delivered` with `deployUrl: null` + `notify` to admins (repo + bundle are the contract). SPA build uploaded to `deliverables/<jobId>/site/` — the bucket is private, so the `siteUrl` only works presigned/console until a CloudFront preview (M6+). Infra: job task role gets `github-token` read (back from the M9 removal, comment explains), `apprunner:Create/Describe/List/StartDeployment/TagResource`, `iam:PassRole` on an empty `mf-apprunner-instance-<env>` role; `APPRUNNER_CONNECTION_ARN` from `config.appRunner`. Review fixes 2026-08-27: service name `mf-<job8>-<slug>` (unique part first, existing service only reused for the same repo), App Runner IAM fenced by the `Service=mf-delivery` tag, `PREVIEW_AUTH_ISSUER` → `AUTH_ISSUER`/`AUTH_JWKS_URL` in `apprunner.yaml` (no deploy attempted without it), polling stops on abort. "URL in portal": `GET /bff/jobs/:id/deliverables` returns `deployUrl`; the portal page is m6-orders
- [x] Deliverable bundle in S3 (repo zip, docs, test report) — 2026-08-27, code + fakes verified. `deliverables/<jobId>/{repo.zip,HANDOVER.md,TEST-REPORT.md,gates.json,acceptance.json}` (git archive of main) via the job's existing `s3:PutObject`; the record is the payload of the final `delivery` event (`Deliverable` in @mf/models — no new job column, so persistence/m3-hardening stay untouched); `GET /bff/jobs/:jobId/deliverables` (org-scoped, 404 until delivered, 503 without a bucket) presigns 15-minute links through the new api `s3` plugin

### M6 — Portal + payment
- [x] Magic-link auth, org/user model — 2026-08-26, login verified end-to-end on dev by Hasse (pulled forward; users/orgs/magic links/refresh tokens persisted in Postgres since 2026-08-27 — `0004_orders_users_auth.sql`, in-memory fallback without `DATABASE_URL`. Api is its own EdDSA token issuer: `/bff/auth/{magic-link,verify,refresh,logout}`, `/.well-known/jwks.json`; `User`/`Org` models, org named after email domain, admins via `AUTH_ADMIN_EMAILS`; portal email form → `/auth/callback`; infra: `auth-jwt-private-key` secret, SES identity + DKIM, dev uses the `log` email transport until SES production access)
- [ ] Sign in with GitHub (decided 2026-08-26): OAuth App → `/bff/auth/github` + callback issuing the same EdDSA session tokens, `githubId`/`githubLogin` on `User`, account linking by verified email; magic link stays as fallback. Doubles as the customer's GitHub identity for M5 repo transfer. Same plugin shape later for Google / BankID. Needs the OAuth App client id/secret (TODO-EXTERNAL)
- [x] Order flow: new order → spec chat → freeze → Stripe deposit → build → deliver → Stripe balance — 2026-08-27 (wave 2, m6-orders): fake provider verified; Stripe test mode pending keys (TODO-EXTERNAL). `Order` state machine drafting → ready → frozen → deposit_paid → building → delivered → paid | cancelled enforced in `orderService.transition` (CAS on `orders.status`); `POST/GET /bff/orders`, `GET /bff/orders/:id` (order + spec status + latest job + payments), `POST …/checkout` (deposit|balance, 50 % of `priceSek`, 25 % moms as its own line, `stripe` npm behind `paymentProvider`), `POST /bff/stripe/webhook` (raw body, signature verified, idempotent on event id → payment paid → order transition → deposit starts the job). Api mints order ids (uuid); the portal's `demo` order is gone. Migration `0006_orders_payments.sql`. Verified: api route/service/plugin tests incl. a payload signed with Stripe's test signing helper, lint/build/smoke/synth.
  - 2026-08-27 (persistence review): `orders.id` is a client-chosen text key in a global namespace (`specService.get` creates the row for the first org that asks; the portal's shared `demo` id therefore belongs to whichever org opens it first, and the param has no format/length limit). Fix belongs to this box: the api mints order ids (uuid, `POST /bff/orders`), the portal stops using `demo`, and `jobs_one_active_per_order` keeps working unchanged.
- [x] Live job progress, deliverables, invoices (Stripe-hosted), token usage — 2026-08-27 (m6-orders): order page with stepper + payment panel (Stripe-hosted `hostedInvoiceUrl`/`receiptUrl` stored from the completed session; fake provider verified, Stripe test mode pending keys), job page shows gate reports from `jobs.gates`, deliverables from `GET /bff/jobs/:id/deliverables` (endpoint lands with m5-delivery; the section degrades gracefully until then), tokens vs budget. sv+en.
- [x] Admin view: all jobs, budgets, kill switch — 2026-08-27 (m6-orders): `/admin` (admins only) lists every job with org/order names (`GET /bff/admin/{jobs,orders,orgs}`), tokens vs budget, kill button, totals (jobs today, tokens today, active). Verified: route tests, lint/build/smoke; not yet exercised on dev.

### M7 — Public site
- [x] Landing, how it works, pricing, contact — sv/en (2026-08-26: built by hand in apps/site + `POST /bff/contact`; verified: api route/service tests, site tests for locale key parity + route paths + sitemap, lint/build, headless smoke of `/` only — the other pages are not smoke-rendered)
- [ ] Built THROUGH the harness (first case study) — 2026-08-26: the site was built by hand tonight; it will be rebuilt through the factory as the M10 dogfood case

### M8 — Resident agent mode
- [x] Deploy agent into customer's AWS account (CDK template) with scoped IAM + customer's own Anthropic key or metered via ours — 2026-08-26, `@mf/resident` (Fastify service: issues labelled `resident` / `POST /tasks` → `@mf/harness` build in a fresh clone → pull request) + `infra/resident` (own CDK app: Fargate task, 4 secrets incl. the customer's Anthropic key, audit/metering bucket, task role limited to those + ECS Exec, one repo via `GITHUB_REPOSITORY`); code + synth verified (`infra/resident` tests), not deployed to a customer account. docs/RESIDENT.md.
- [x] Monthly token cap, pause button, audit log of every action — 2026-08-26, `RESIDENT_MONTHLY_TOKENS` (persisted month counter, task budget = what is left, overshoot ≤ one model turn), `POST /pause|/resume` (persisted flag, doubles as the kill switch for the task in flight), `audit/<day>.jsonl` in the bucket + `GET /audit?day=`; verified with fakes (`packages/resident/test`), not deployed.
- [ ] Metering → Stripe usage-based billing — 2026-08-26: metering done (daily `usage/<day>.json`: tokens by model, tasks, list price × 1.5; `POST /internal/resident/usage` contract in `@mf/models`, api stores records in memory via `residentService`, bearer per installation from `RESIDENT_INSTALLATIONS`). Stripe usage-based billing of those records is m6-orders' provider interface — not built.

### M9 — Ops
- [x] Logs + alerts: token burn per job, failed jobs, cost anomalies — 2026-08-26, `ops-<env>` stack (SNS `mf-alerts-<env>` → adminEmails, 9 alarms, monthly budget); synth-verified + `infra/test`, deploy pending (main session). E-mail subscription confirmation + cost-allocation tag in TODO-EXTERNAL.
- [x] Backups (RDS automated), incident runbook — 2026-08-26, RDS 7 d dev / 30 d live + snapshot-on-delete, artifacts bucket versioned with 90 d noncurrent expiry, docs/RUNBOOK.md; synth-verified, deploy pending.
- [x] Security baseline: secrets in Secrets Manager, least-privilege IAM, dependency scanning — 2026-08-26, synthesised task defs carry ARNs only and no credential-looking values (asserted in `infra/test/security-baseline.test.ts`), job role narrowed to `s3:PutObject*`, roles documented per action (remaining sandbox gaps — master DB secret, bucket-wide put — tracked under M3 hardening), `.github/dependabot.yml` + `npm audit` step (allow-fail), CloudFront headers incl. nosniff; deploy pending.
- [ ] RDS TLS `verify-full` by default with the RDS CA bundle in the api/job images (`DATABASE_SSL`, docs/M3-REVIEW.md #12)

### M10 — Proof
- [ ] Dogfood: 3 internal apps built end-to-end from spec, results logged in TOKENS.md
  - 2026-08-27 (wave 3, efficiency): worker loop tuned without live calls — task gate scoped by the task's actual diff, size-based turn caps (S 60 / M 100 / L 150) with a second session as safety valve and cap hits recorded on the task events, gate-at-most-twice prompt, trimmed conventions, prompt-caching kill switch stripped (caching itself to be confirmed via `cache_read_input_tokens` on the dogfood run), `WORKER_EFFORT` knob; analysis + expected savings in docs/EFFICIENCY.md. The savings are estimates: the first dogfood job must re-measure turns / budget-tokens per turn / gate runs per task against the 2026-08-26 baseline (S demo: 42 + 119 turns, 190k + 1.25M) before any number is trusted.
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
