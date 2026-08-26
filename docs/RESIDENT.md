# Resident agent (M8)

The resident is the factory's "stay behind" mode: after an application has been delivered, a
long-running agent lives **in the customer's own AWS account**, on **the customer's own Anthropic
key**, and keeps working on **one GitHub repository** — every issue labelled `resident` (or a task
posted to its `/tasks` endpoint) becomes a pull request built through the same `@mf/harness`
orchestrator and M4 gates as a factory job. It never merges: the customer reviews and merges the
PR.

Code: `packages/resident` (`@mf/resident`), `infra/resident` (CDK app the customer deploys),
contract in `packages/models/schemas/Resident.api.ts`, api side `apps/api/src/routes/internal/resident/`.

## What it does

```
GitHub issue (label: resident) ──┐
POST /tasks {title, description} ┴─▶ queue ─▶ fresh clone ─▶ @mf/harness runJob
                                                (plan → workers → merge → verify → M4 gates)
                                              ─▶ branch resident/<id> ─▶ push ─▶ pull request
                                                                    └─▶ issue comment + label
```

- **One task at a time**, oldest first. A task is a single-feature spec: the issue title is the
  goal, the body the description, markdown checklist lines (`- [ ] …`) are the acceptance
  criteria the gates prove (without a checklist the title is the one criterion).
- **Labels** on the issue track progress: `resident` (queue) → `resident:running` →
  `resident:done` (with a comment linking the PR) or `resident:failed` (with the reason). An
  issue carrying `resident:done` / `resident:failed` is not picked up again; remove
  `resident:failed` to retry it (no restart needed). An issue still labelled `resident:running`
  when the resident has no such task in flight (a crash, a redeploy) is re-queued on the next
  poll (`task_requeued`), so nothing is stranded behind a label.
- **Hard monthly token cap** (`RESIDENT_MONTHLY_TOKENS`, budget-weighted tokens, cache reads
  at 10 %): the month counter lives in the bucket (`months/<YYYY-MM>.json`), each task starts
  with a budget of `min(RESIDENT_TASK_TOKENS, what the month has left)` and the harness aborts it
  the moment that is crossed, so the cap overshoots by at most one model turn. Nothing starts
  once the cap is reached (`cap_reached` in the audit log); a new UTC month resets.
- **Pause button**: `POST /pause` / `POST /resume` (or `RESIDENT_PAUSED=1`). The flag is
  persisted (`state/paused.json`), survives restarts, and doubles as the kill switch for the
  task in flight (aborted within ~10 s, reported `killed`).
- **Audit log**: every action is one JSON line in `audit/<YYYY-MM-DD>.jsonl` in the bucket,
  written before the next action starts, and also in the container log. Types:
  `resident_started`, `paused`, `resumed`, `cap_reached`, `task_queued`, `task_started`,
  `planned` (the plan's steps), `worker` (each harness task started/finished/failed/merged),
  `command_run` (`by: verify-gate` — the gate's own `npm run lint` + `npm test`; commands the
  worker sessions run are not visible to the resident, see below), `gate` (each M4 gate with
  tokens and summary), `tokens` (running totals), `files_changed` (paths the build touched),
  `pr_opened`, `task_finished` / `task_failed` / `task_requeued`, `usage_reported`.
  `GET /audit?day=YYYY-MM-DD` returns a day. **Fail closed**: an audit line that cannot be
  written to the bucket rejects the action, pauses the resident (the task in flight is aborted)
  and is logged; the line stays in memory and goes out with the next successful write after a
  `POST /resume`.
- **Metering**: one record per UTC day (`usage/<day>.json` in the bucket, `ResidentUsageRecord`):
  tokens by model (all buckets + the budget-weighted total), task counts, and a cost estimate at
  Anthropic list price × 1.5. The same record is `POST`ed to the factory
  (`FACTORY_API_URL` + `FACTORY_TOKEN`, `POST /internal/resident/usage`), where the api persists
  it (`resident_usage`, one row per installation and day) and aggregates it per month for Stripe
  usage-based billing (see Cost model). A day is re-sent on every flush (last write wins), so an
  outage loses nothing.

### Control api

All endpoints but `/health` require `Authorization: Bearer <admin-token>`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness |
| GET | `/status` | paused flag, month cap (tokens / used / remaining / reached), running task, queue length |
| POST | `/pause`, `/resume` | pause button (persisted) |
| GET | `/tasks` | tasks seen since start (queued / running / done / failed, PR url, tokens) |
| POST | `/tasks` | `{ title, description }` → queued task |
| GET | `/audit?day=` | the day's audit entries (today by default) |

### Security model

- The container holds four secrets, read from Secrets Manager at start-up (only their ARNs are
  in the task definition — nothing is injected by ECS, because the initial environment of pid 1
  stays readable from `/proc` for the worker sessions, which share the container and its uid)
  and then wiped from its environment: the customer's Anthropic key, a GitHub token, the
  factory bearer, the admin token. Worker sessions and the repo's own scripts inherit the
  sandboxed environment of `@mf/harness` (`sandboxEnv` strips `*_SECRET_ARN`, `AWS_*`,
  `GITHUB_TOKEN`, `JOB_TOKEN`, …). Residual risk: the ECS task-role credential endpoint
  (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`) is in pid 1's environment and reachable from the
  container, so a prompt-injected worker could obtain the task role — which is limited to
  reading the four secrets and reading/putting (never deleting) the versioned bucket. Running
  worker sessions under a separate uid is on the list below.
- Until the customer fills a secret it holds a JSON placeholder the resident recognises as "not
  configured" (a bare random string would pass for a credential): no GitHub token → the service
  refuses to start with a clear message, no factory token → usage records stay in the bucket.
- The GitHub token is used in the URL of the one `git clone` / `git push` process and for the
  REST calls; `origin` is reset to the plain URL right after the clone so the token never lands
  in `.git/config` inside the workspace the model sees.
- The task role can read exactly those four secrets, read and put (not delete) in exactly the
  audit bucket, and use ECS Exec — nothing else in the customer's account. The service is scoped to one repository
  by `GITHUB_REPOSITORY`; the customer should issue a fine-grained token limited to that repo.
- The control api is reachable only inside the VPC by default (`aws ecs execute-command` →
  `wget` from the container, see below). `-c exposeApi=true -c certificateArn=<ACM arn>` puts it
  behind a public ALB, HTTPS only (port 80 redirects); without a certificate the synth fails.

## Deploy (customer account)

Prerequisites: AWS CLI credentials for the target account, Node 24, Docker (the resident image
is built locally and pushed by CDK), `cdk bootstrap` done once in the account/region.

```shell
git clone https://github.com/mjukvaruhuset/mjukvarufabriken && cd mjukvarufabriken
npm ci                                   # workspace deps (the image build needs the lockfile)
npm i --prefix infra/resident
cd infra/resident
npx cdk deploy -c repository=acme/shop -c monthlyTokens=50000000
```

Context keys (`-c key=value`, defaults in `cdk.json`): `repository` (required, `owner/name`),
`installationId` (default `owner--name`), `monthlyTokens`, `taskTokens` (default 6M — the M
size class), `factoryApiUrl`, `exposeApi`, `cpu` / `memoryMiB` (default 2 vCPU / 4 GB),
`workerModel` / `planModel`.

After the first deploy, fill the secrets the stack created (the outputs list their ARNs):

```shell
aws secretsmanager put-secret-value --secret-id mf-resident/acme--shop/anthropic-api-key --secret-string sk-ant-…
aws secretsmanager put-secret-value --secret-id mf-resident/acme--shop/github-token      --secret-string github_pat_…   # fine-grained: contents, issues, pull requests (write) on acme/shop only
aws secretsmanager put-secret-value --secret-id mf-resident/acme--shop/factory-token     --secret-string <token from Mjukvaruhuset>
# admin-token: the generated value is fine; read it with get-secret-value when you need it
aws ecs update-service --cluster <ClusterName output> --service <ServiceName output> --force-new-deployment
```

The factory side needs the installation registered: an `id:token` entry in the api's
`RESIDENT_INSTALLATIONS` (secret `RESIDENT_INSTALLATIONS_SECRET_ARN`), with the same token
as `factory-token`. Until then the records still land in the customer's bucket (the resident
logs `reporting usage failed`).

Label an issue `resident` and watch `/mf-resident/<installationId>` in CloudWatch Logs; the
PR appears on the repository when the gates are green.

### Local / dry run

```shell
RESIDENT_DRY_RUN=1 node packages/resident/src/index.ts      # fakes: no GitHub, no S3, no model
GITHUB_REPOSITORY=acme/shop GITHUB_TOKEN=… ANTHROPIC_API_KEY=… RESIDENT_BUCKET= node packages/resident/src/index.ts
```

Without `RESIDENT_BUCKET` the audit log and usage records stay in memory (fine for a laptop).
Docker: `docker build -f packages/resident/Dockerfile .`

## How to pause / stop

| Want | Do |
|---|---|
| Pause (finish nothing new, abort the running task) | `curl -X POST -H "Authorization: Bearer $ADMIN" http://<control api>/pause` — from inside the VPC, or through ECS Exec: `aws ecs execute-command --cluster <cluster> --task <task> --container resident --interactive --command "wget -qO- --header='Authorization: Bearer $ADMIN' --post-data='' http://127.0.0.1:5176/pause"` |
| Pause without any api access | `aws s3 cp - s3://<bucket>/state/paused.json <<< '{"paused":true}'` then `aws ecs update-service … --force-new-deployment` (the flag is read at start-up) |
| Resume | `POST /resume` (or write `{"paused":false}` and redeploy) |
| Stop completely (no cost but the bucket) | `aws ecs update-service --cluster <cluster> --service <service> --desired-count 0` |
| Remove | `npx cdk destroy -c repository=acme/shop` — the bucket (audit trail, usage records) is retained |
| Lower the cap mid-month | redeploy with `-c monthlyTokens=…`; the month counter is kept, so a cap below what is already used stops the resident immediately |

A stop (`SIGTERM`, deploy, scale to 0) aborts the running task through the kill switch (within
~10 s, inside the 120 s ECS stop timeout), re-queues it (`task_requeued`, `resident:running`
removed so the issue is picked up again after the restart), flushes the day's usage record and
audit lines, and exits. A plain crash leaves `resident:running` on the issue; the next poll
re-queues it.

## Cost model

Billed by the factory from the daily records above (wave 4 `billing-and-tls`):

- The api aggregates `resident_usage` per installation and month
  (`GET /bff/admin/resident/usage?month=YYYY-MM`, admin). An admin links each installation to its
  org and Stripe customer (`PUT /bff/admin/resident/installations/:id`
  `{ orgId, billingCustomerId }`); until then the installation shows up unlinked and is skipped by
  billing (`no_customer`).
- `POST /bff/admin/resident/usage/:month/bill` (admin, run after month end and again for late
  records) reports each installation's billable amount as **US cents** to a Stripe **billing
  meter** (`stripe.billing.meterEvents.create`, `event_name` = `RESIDENT_USAGE_METER_EVENT`,
  default `resident_usage_usd_cents`; the metered price on the customer's subscription is
  `RESIDENT_USAGE_PRICE_ID`, informational). The cumulative cents reported per month are stored
  (`resident_usage_reports`), so a re-run only sends the difference and an unchanged month sends
  nothing. Without a Stripe key the fake provider records the report locally.

- **Usage**: Anthropic list price of the tokens the resident used × **1.5**. The estimate in
  each daily record uses the per-model price table in `packages/resident/src/pricing.ts`
  (override with `RESIDENT_PRICES_JSON`). Note that harness worker sessions report
  budget-weighted deltas into the input bucket, so the estimate is on the low side for
  output-heavy work; the customer's own Anthropic invoice is the authoritative usage.
- **Monthly fee**: fixed, per installation (price point open in PLAN.md).

Paid by the customer directly:

- Anthropic: their own key, their own invoice (v1 decision — no metering risk for us).
- AWS, roughly per month: Fargate 2 vCPU / 4 GB running 24/7 ≈ 70 USD (scale to 0 when idle, or
  use a 0.5 vCPU / 1 GB task with `-c cpu=512 -c memoryMiB=1024` ≈ 18 USD when the repo is small),
  Secrets Manager 4 × 0.40 USD, S3/CloudWatch cents, no NAT gateway (public subnets), optional ALB
  ≈ 16 USD with `exposeApi`.

## What is not there yet

- Stripe usage-based billing of the records (m6-orders provider interface).
- Persistent task list: the queue is in memory; the audit log and the issue labels are the
  durable record. Issues survive a restart (re-polled), `POST /tasks` entries do not.
- A per-file / per-command hook inside worker sessions: `files_changed` is the diff of the build,
  `command_run` covers the verify gate; commands the model runs inside its session are in the
  Agent SDK transcript, not in the audit log (needs a PreToolUse hook in `@mf/harness`).
- A separate uid for worker sessions (see the security model).
- The image is built and pushed from the deploying machine; a published image in a registry
  would make the customer deploy Docker-free.
