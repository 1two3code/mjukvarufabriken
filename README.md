# Mjukvaruhuset — mjukvaruhuset.se

A one-shot software factory: a customer describes what they want in the portal, a spec engine
turns the chat into a frozen, priced specification, a build job on ECS Fargate plans the work,
runs Claude Agent SDK workers in parallel git worktrees, gates the result (acceptance tests,
independent review, acceptance check) and delivers a GitHub repository, an App Runner URL and a
deliverable bundle. Payment is Stripe Checkout (50 % deposit before the build, 50 % on delivery).
After delivery a "resident" agent can keep working on the repo from inside the customer's own AWS
account, metered per token.

The repository folder name (`mjukvarufabriken`) is historical; the brand is **Mjukvaruhuset**.
Road map, decisions and milestone details: [PLAN.md](PLAN.md). Anything that needs someone else's
approval (accounts, keys, reviews): [TODO-EXTERNAL.md](TODO-EXTERNAL.md). Token spend per session:
[TOKENS.md](TOKENS.md).

## Milestone status

Hand-copied from [PLAN.md](PLAN.md) on 2026-08-27 — PLAN.md is the source of truth, this table
is the summary.

| Milestone | Status | Notes |
| --------- | ------ | ----- |
| M1 Skeleton | done | monorepo from `templates/web`, CI, CDK stacks, token ledger |
| M2 Spec engine | done | structured spec chat, clarification loop, S/M/L pricing, freeze (live-model behaviour verified via `spec:demo`) |
| M3 Orchestrator + sandbox | mostly | Fargate job, budget/kill switch/egress allowlist, live events; the plan → DAG → workers → merge chain has run on dev but not yet to a green end-to-end delivery |
| M4 QA gates | mostly | acceptance-tests, review and acceptance-check gates unit-verified, fail closed; M3 hardening (job reports through the api, no RDS secret in the job) built, live run pending |
| M5 Delivery | done (dry-run) | handover docs, GitHub repo, App Runner deploy, S3 bundle — live delivery waits on the GitHub org and App Runner connection |
| M6 Portal + payment | mostly | magic-link auth, order flow with Stripe (fake provider verified, test keys pending), live progress, deliverables, admin view; GitHub sign-in built but not exercised against GitHub |
| M7 Public site | mostly | landing/how it works/pricing/contact in sv+en, built by hand — the "built through the harness" case study is the M10 dogfood |
| M8 Resident agent | mostly | `@mf/resident` + `infra/resident`, cap/pause/audit/metering with fakes; Stripe usage billing built, waits on a meter + one invoiced month |
| M9 Ops | done (synth) | alarms, budget, backups, runbook, security baseline, RDS TLS verify-full — template-tested; `ops`/`budget` land with the next dev deploy, then confirm the SNS subscription e-mails |
| M10 Proof | open | 3 dogfood apps end-to-end; pilot contracts drafted in `legal/`, unreviewed |

## Repository layout

npm-workspaces TypeScript monorepo (ESM, Node ≥ 24.14) instantiated from `templates/web`, the
golden template every customer build also starts from — never edit the template in place.

```
apps/site        @mf/site      public site SPA (sv+en), Vite :5175
apps/portal      @mf/portal    customer portal SPA (sv+en), Vite :5173
apps/api         @mf/api       Fastify BFF for both SPAs, token issuer, Stripe, job control, :5174
apps/job         @mf/job       build-job container (Fargate): loads a job, runs the harness orchestrator
packages/models  @mf/models    Zod schemas shared by everything (Spec, Order, Job, GateReport, …)
packages/harness @mf/harness   spec engine + orchestrator (plan → DAG → Agent SDK workers → merge → gates → delivery)
packages/db      @mf/db        Postgres driver, repositories, migrations/ (`npm run db:migrate`)
packages/resident @mf/resident resident agent service for a customer's AWS account (docs/RESIDENT.md)
packages/utils, packages/access-control
infra/           CDK app (not a workspace): resources-<env>, mf-<env>, ops-<env>, budget-<env>
infra/resident/  CDK app a customer deploys into their own account for the resident
templates/web    golden template (own CLAUDE.md with the conventions used here 1:1, @template/* → @mf/*)
legal/           Swedish contract drafts (unreviewed)
docs/            RUNBOOK, RESIDENT, EFFICIENCY, M3 brief/review, backlog/ (overnight wave briefs)
.github/         ci.yml (lint / coverage / build / smoke / synth / infra tests), deploy.yml → deploy-environment.yml (OIDC)
```

## Local development

Prerequisites: Node 24 (`.nvmrc`), npm 11, Docker (for Postgres and the job image), AWS CLI only
for deploys. Secrets and AWS credentials live in the root `.env` (gitignored, loaded by the
`node --env-file-if-exists=.env` scripts and by `infra/scripts/deploy.sh`).

```shell
npm i && npm i --prefix infra && npm i --prefix infra/resident

docker compose up -d                 # Postgres 17 on :5432 (user/password/db: mf)
npm run db:migrate                   # forward-only migrations from packages/db/migrations
npm run start:dev                    # site :5175, portal :5173, api :5174 (api reads apps/api/.env.dev)

npm run db:seed                      # insert a queued demo job with a tiny frozen spec, prints its id
npm run job:dev -- <job-id>          # run that job locally with the orchestrator (needs ANTHROPIC_API_KEY)
npm run gates:demo -- --repo <built repo> --spec spec.json    # only the M4 gates on an existing repo
npm run spec:demo                    # spec chat against the live model
npm run delivery:demo -- --repo <built repo> --dry-run        # M5 delivery steps without side effects

docker compose --profile job build   # job + egress-proxy images, same as Fargate
JOB_ID=<id> docker compose --profile job run --rm job         # job behind the allowlist proxy
```

Sign-in locally: `EMAIL_TRANSPORT=log` prints the magic link in the api log; copy it into the
browser. `AUTH_ADMIN_EMAILS` decides who gets the `admin` role (`/admin` in the portal).

### Verify (what CI runs)

```shell
npm run lint                         # ESLint + tsgo per workspace, Stylelint in the SPAs
npm test                             # vitest across api, site, job, utils, harness, db, resident
npm run coverage                     # same with V8 coverage; fails below lines 60 % (vitest.config.ts)
npm run build && npm run smoke       # Vite builds (dev + live) + headless-Chrome smoke of both SPAs
cd infra && npx cdk synth --quiet && npm test    # 4 stacks × 2 envs offline, template assertions
cd infra/resident && npm run lint && npm test    # the customer-side CDK app
```

`npm test -- --project @mf/api`, `npm test -- <file>` and `npm run lint -w @mf/api` narrow it down.

## Environment variables

Local values go in the root `.env` (scripts, deploy) and `apps/api/.env.dev` (copy
`apps/api/.env.example`). In AWS the CDK stacks set the `*_SECRET_ARN` variants and the api/job
resolve them from Secrets Manager at start-up — see `infra/README.md` for the secret names.

| Variable | Used by | Purpose |
| -------- | ------- | ------- |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | deploy.sh, api (SES/S3/ECS locally) | AWS credentials; region defaults to `eu-north-1` |
| `ANTHROPIC_API_KEY` (`_SECRET_ARN`) | api (spec engine), job, harness scripts, resident | Anthropic key; without it demos exit "skipped" |
| `SPEC_MODEL`, `PLAN_MODEL`, `WORKER_MODEL`, `WORKER_EFFORT` | api, job, harness | model per role (default `claude-sonnet-5`), worker effort knob (docs/EFFICIENCY.md) |
| `DATABASE_URL` (`DATABASE_SECRET_ARN`), `DATABASE_SSL`, `DATABASE_SSL_CA` | api (`_SECRET_ARN` on Fargate), db scripts, job only for local `job:dev` — on Fargate the job reports through the api with `API_URL` + `JOB_TOKEN` and holds no database credentials | Postgres; TLS is `verify-full` for RDS hosts, plaintext for localhost, override with `disable\|require\|verify-full` |
| `ADDRESS`, `PORT`, `LOG_LEVEL`, `ENV`, `APP_URL`, `PORTAL_URL`, `TRUSTED_PROXY_HOPS` | api | listener, log level, portal URL for magic links, proxy hops for client ip |
| `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWT_PRIVATE_KEY` (`_SECRET_ARN`), `AUTH_ADMIN_EMAILS` | api | EdDSA token issuer (`node scripts/gen-auth-key.mjs` makes a key; empty = ephemeral), admin allowlist |
| `EMAIL_TRANSPORT` (`log\|ses`), `AUTH_EMAIL_FROM` | api | magic-link mail: log it or send through SES |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` (`_SECRET_ARN`) | api, portal (`VITE_GITHUB_SIGNIN`) | "Sign in with GitHub"; routes are 404 and the button hidden without a client id |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (`_SECRET_ARN`), `RESIDENT_USAGE_METER_EVENT`, `RESIDENT_USAGE_PRICE_ID` | api | Stripe Checkout + webhook; without a key the fake provider marks payments paid at once; resident usage meter |
| `ARTIFACTS_BUCKET`, `JOBS_CLUSTER_ARN`, `JOB_TASK_DEFINITION_ARN`, `JOB_SUBNET_IDS`, `JOB_SECURITY_GROUP_ID`, `JOB_API_URL`, `JOB_NO_PROXY` | api | start Fargate jobs (`ecs:RunTask`), presign deliverables, where jobs report back |
| `JOB_ID`, `JOB_TOKEN`, `API_URL`, `WORK_DIR`, `TEMPLATE_DIR`, `HTTP(S)_PROXY`, `NO_PROXY` | job | which job to run, per-job report token (Fargate), work dir, template path, egress proxy |
| `GITHUB_TOKEN`, `GITHUB_ORG`, `APPRUNNER_CONNECTION_ARN`, `APPRUNNER_INSTANCE_ROLE_ARN`, `DELIVERY_DRY_RUN`, `PREVIEW_AUTH_*` | job (delivery) | create/push the customer repo, App Runner deploy; dry-run logs instead |
| `SEED_MAX_TOKENS`, `SEED_MAX_WORKERS`, `SEED_ORG_ID` | `db:seed` | budget/workers/org of the demo job |
| `RESIDENT_INSTALLATIONS` (`_SECRET_ARN`) | api | installation id → bearer for `POST /internal/resident/usage` |
| `GITHUB_REPOSITORY`, `FACTORY_API_URL`, `RESIDENT_INSTALLATION_ID`, `RESIDENT_BUCKET`, `RESIDENT_MONTHLY_TOKENS`, `RESIDENT_TASK_*`, `RESIDENT_POLL_INTERVAL_MS`, `RESIDENT_PAUSED`, `RESIDENT_PRICES_JSON`, `RESIDENT_DRY_RUN` | resident | the one repo, usage reporting, monthly cap, per-task limits, pause, prices (docs/RESIDENT.md) |
| `VITE_API_URL`, `VITE_APP_TITLE`, `VITE_PORTAL_URL`, `VITE_GITHUB_SIGNIN` | site, portal | `/bff` in every mode (Vite proxies locally, CloudFront forwards in AWS) |
| `CDK_DEFAULT_ACCOUNT`, `CDK_DEFAULT_REGION` | infra | set by deploy.sh / the workflow; unset → environment-agnostic offline synth |

## Deploy

Push to `main` deploys `dev`, then `live` (gated by the `live` GitHub environment) through OIDC —
`.github/workflows/deploy.yml`. Manually: `infra/scripts/deploy.sh dev` deploys
`resources → mf → ops → budget`, bootstrapping the account in `eu-north-1` and `us-east-1` the
first time. Details, rollback, alarms and restores: [docs/RUNBOOK.md](docs/RUNBOOK.md); stacks,
secrets and cost: [infra/README.md](infra/README.md).

## Further reading

- [docs/RUNBOOK.md](docs/RUNBOOK.md) — operating dev/live: deploys, logs, killing jobs, alarms, restores, key rotation
- [docs/RESIDENT.md](docs/RESIDENT.md) — the resident agent: what it does, how a customer deploys it, cost, pause
- [docs/EFFICIENCY.md](docs/EFFICIENCY.md) — where worker tokens go and the levers in the harness
- [docs/M3-BRIEF.md](docs/M3-BRIEF.md), [docs/M3-REVIEW.md](docs/M3-REVIEW.md) — orchestrator design and its review findings
- [docs/backlog/](docs/backlog/README.md) — the overnight wave briefs (one per stream, waves 1–5)
- [legal/](legal/README.md) — contract drafts for lawyer review
- `templates/web/CLAUDE.md`, `.claude/rules/` — code conventions (apply here with `@mf/*`)
