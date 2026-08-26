# Runbook — mjukvaruhuset.se

Operations reference for the `dev` and `live` environments (eu-north-1). Everything below assumes
AWS credentials in the shell (`set -a; . .env; set +a` from the repo root) and `ENV=dev|live`.
Infra details: `infra/README.md`; alarms are defined in `infra/lib/ops-stack.ts`.

## Where things are

| What                        | Where                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| api logs (pino JSON)        | CloudWatch log group `/mf/<env>/api`, streams `api/web/<task-id>`                                                                         |
| build-job logs (JSON lines) | CloudWatch log group `/mf/<env>/jobs`, streams `job/job/<task-id>` (the harness) and `proxy/egress-proxy/<task-id>` (tinyproxy allowlist) |
| job rows + events           | Postgres tables `jobs`, `job_events` (secret `rds-secret-arn` output of `resources-<env>`)                                                |
| deliverables                | S3 bucket from the `s3-artifacts` output (versioned, old versions kept 90 days)                                                           |
| alarms + budget             | CloudWatch → Alarms, prefix `mf-<env>-`; AWS Budgets `mf-<env>-monthly`; all publish to SNS `mf-alerts-<env>`                             |
| secrets                     | Secrets Manager `mf/<env>/*` (see "Rotating keys")                                                                                        |
| running jobs                | ECS cluster `mf-jobs-<env>`, task family `mf-job-<env>`                                                                                   |
| api service                 | ECS cluster in `mf-<env>` (service `mf-<env>-Api…`), ALB behind `https://api.<env>.mjukvaruhuset.se`                                      |

## Reading a job's events

Every job event is written twice: to `job_events` (what the portal shows) and as a JSON log line
`{"time":…,"message":"event <type>","jobId":"…",...payload}`. Terminal lines are
`"event done"` / `"event failed"` followed by `"job finished"` with `status` and `tokensUsed` —
or, when the task dies outside the orchestrator (SIGTERM from ECS, OOM, unhandled rejection,
seed/DB errors), a single `"job crashed"` line with `reason` and no `job finished`. Note that the
customer's own build scripts write to the same log stream, so nothing here is tamper-proof until
the job reports through the api instead (PLAN.md, M3 hardening).

```shell
# Everything one job logged, oldest first (CloudWatch Logs Insights)
aws logs start-query --log-group-name /mf/$ENV/jobs \
  --start-time $(date -d '-24 hours' +%s) --end-time $(date +%s) \
  --query-string 'fields @timestamp, message, phase, reason, tokensUsed | filter jobId = "<job-id>" | sort @timestamp asc'
aws logs get-query-results --query-id <id-from-above>

# Or tail live while a job runs
aws logs tail /mf/$ENV/jobs --follow --filter-pattern '{ $.jobId = "<job-id>" }'
```

The proxy stream shows every outbound request the job attempted; a `403` there means the domain
is not on the allowlist (`apps/job/proxy/filter`).

Locally: `npm run job:dev -- <job-id>` against docker-compose Postgres prints the same lines.

## Killing a job

1. **Portal**: as admin open the job → "Kill". This sets `status = killed` and calls
   `ecs:StopTask` (`POST /bff/admin/jobs/:id/kill`).
2. **CLI**, if the api is down or the button did nothing:

```shell
aws ecs list-tasks --cluster mf-jobs-$ENV --family mf-job-$ENV
aws ecs stop-task --cluster mf-jobs-$ENV --task <task-arn> --reason "runbook: manual kill"
# then mark the row so the portal agrees
psql "$DATABASE_URL" -c "update jobs set status='killed', finished_at=now() where id='<job-id>'"
```

Stopping the task also stops token spend immediately — the Agent SDK workers run inside it.

## Deploying

Every push to `main` runs `.github/workflows/deploy.yml` (dev, then live behind the `live`
environment's required reviewer); `workflow_dispatch` deploys one environment on demand. From a
shell the same thing is `infra/scripts/deploy.sh <env> [stack...]` with AWS credentials in the
root `.env`. Both deploy the stacks in this order and stop at the first failure:

| # | Stack | Region | Contents |
| - | ----------------- | ----------- | -------------------------------------------------------- |
| 1 | `resources-<env>` | eu-north-1 | VPC, RDS, artifacts bucket, secrets, jobs cluster + task |
| 2 | `mf-<env>` | eu-north-1 | site + portal (S3/CloudFront), api (Fargate + ALB) |
| 3 | `ops-<env>` | eu-north-1 | SNS `mf-alerts-<env>`, CloudWatch alarms |
| 4 | `budget-<env>` | us-east-1 | AWS Budgets monthly cost budget → the alerts topic |

`cdk bootstrap` is a one-time step per account **and region**; both deploy paths check for the
`CDKToolkit` CloudFormation stack in the stack region and in us-east-1 (needed by `budget-<env>`)
and only bootstrap when it is missing. The GitHub deploy role therefore needs the rights the
bootstrap uses the first time (CloudFormation, S3, ECR, IAM for `CDKToolkit`); after that
plain deploy rights are enough. `budget-<env>` reads nothing across regions — it builds the topic
ARN from the account id, so it can be deployed alone (`deploy.sh dev budget-dev`) after `ops-<env>`
exists.

Before the first deploy of an environment: `npm run build` (the SPA bundles are CDK assets),
then fill the Secrets Manager placeholders after `resources-<env>` (`infra/README.md` → Secrets).
After the first `ops-<env>`: the alert delivery checklist at the bottom of this file.

## Rolling back a deploy

Deploys are `cdk deploy` of a commit; rolling back is deploying the previous one.

```shell
git checkout <previous-commit>            # or the last green main
npm ci && npm run build                   # SPA bundles are uploaded by mf-<env>
infra/scripts/deploy.sh $ENV mf-$ENV      # api + site + portal (resources-<env> rarely needs it)
```

- The api service runs with `minHealthyPercent: 50` and a deployment circuit breaker: a task set
  that fails `/health` is rolled back by ECS on its own — check
  `aws ecs describe-services --cluster <mf-env cluster> --services <api service>` → `deployments`
  and `events`.
- `resources-<env>` only needs redeploying for a job image change; the api resolves the job task
  family's **latest** revision, so an old job task definition can be re-pointed by deploying the
  old commit's `resources-<env>`.
- Database migrations are forward-only (`npm run db:migrate`); if a rollback needs the previous
  schema, restore from a snapshot (below) rather than hand-editing.

## Alarms — what they mean and what to check first

All alarms e-mail `adminEmails` through `mf-alerts-<env>` (and again on OK). Thresholds live in
`infra/lib/config.ts` → `alerts`.

### jobs-failed

A job logged `event failed` (the orchestrator gave up) or `job crashed` (the task died: SIGTERM,
OOM, unhandled rejection, seed/DB error) in the last 5 minutes.
First: find the job (`filter message in ["event failed", "job crashed"]` in `/mf/<env>/jobs`)
and read its `reason`.
Common for `event failed`: budget exhausted (`tokensUsed` near the job limit), a gate that never
went green, proxy 403 on a domain the build needed, worker timeouts. The job row keeps `plan` +
`error` for the portal. Common for `job crashed`: OOM (`aws ecs describe-tasks` → `stoppedReason`),
a kill from the api (SIGTERM), Secrets Manager / Postgres unreachable at start-up.

### job-token-burn

A single job finished having used more than `alerts.jobTokensThreshold` tokens (20 M default).
First: which job (`filter message = "job finished" | sort tokensUsed desc`), then its plan — a
runaway retry loop in one step is the usual cause. Consider lowering the per-job budget in the
harness for that spec size.

### api-5xx

5 or more HTTP 5xx from the api (target + ALB) in 5 minutes.
First: `/mf/<env>/api` filtered on `level >= 50` (pino error) for the stack trace. ALB-side 5xx
with no api errors means no healthy target — see `api-unhealthy`. A burst right after a deploy
means the new task set is failing; ECS rolls it back (see rolling back).

### api-unhealthy

An api task has failed the `/health` check for 10 minutes.
First: `aws ecs describe-services` → `events` (OOM, image pull, secret access denied), then the
task's log stream. `/health` only reflects *boot-time* database failures (secret resolution or
migrations failed → 503 `DEGRADED`); it does not probe Postgres afterwards, so a task that
started fine and then lost the database stays "healthy" and shows up as `api-5xx` instead. For a
task that never became healthy: check the `rds-*` alarms, the security-group ingress
(`api to postgres`) and the `DATABASE_SECRET_ARN` grant.

### rds-cpu

Postgres CPU > 80 % for 15 minutes.
First: RDS Performance Insights / `pg_stat_activity` for a long-running query; on a `t4g.micro`
this often means the CPU credit balance is gone — check `CPUCreditBalance`. Scale
`database.instanceType` in config if it is sustained.

### rds-storage

Free storage < 2 GB.
First: what grew — `select relname, pg_size_pretty(pg_total_relation_size(oid)) from pg_class
order by 2 desc limit 10`; `job_events` is the likely one. Raise `allocatedStorageGb` (RDS grows
online, no downtime) or prune old events.

### rds-memory

Freeable memory < 128 MB for 15 minutes.
First: connection count (`select count(*) from pg_stat_activity`) — each api/job connection
costs memory; a job task that leaked connections shows up here. Restart the offending task or
scale the instance.

### nat-egress / nat-egress-anomaly

The NAT gateway sent more than `alerts.natBytesOutPerHourThreshold` in an hour, or far above its
usual pattern (anomaly band, needs ~2 weeks of history before it is meaningful). NAT data
processing is billed per GB — this is the cost alarm.
First: which tasks are running (`aws ecs list-tasks` on both clusters) and the proxy stream of
any job — repeated multi-GB downloads/uploads (a dependency install loop, an artifact upload that
retries forever) are the usual cause. An api task in a crash loop pulling its image also counts.
S3 and Secrets Manager traffic goes through the NAT too; VPC endpoints would take it off this
metric (TODO-EXTERNAL, egress fence row).

### Budget `mf-<env>-monthly`

80 % of `alerts.monthlyBudgetUsd` spent, or the month's forecast is over 100 %.
First: Cost Explorer grouped by service, filtered on tag `Environment=<env>`. The baseline is
NAT (~35) + RDS (~15–30) + ALB (~20) + Fargate api (~15); anything above is jobs.

## RDS restore

Automated backups: 7 days (dev) / 30 days (live), plus a final snapshot if the live instance is
ever deleted. Restores always create a **new** instance; the stack's instance is then swapped.

```shell
# 1. Pick a point in time (or a snapshot id from `describe-db-snapshots`)
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier <current-instance-id> \
  --target-db-instance-identifier mf-$ENV-restore-$(date +%Y%m%d) \
  --restore-time 2026-08-26T10:00:00Z \
  --db-subnet-group-name <same as source> --vpc-security-group-ids <DatabaseSecurityGroup id> \
  --db-instance-class db.t4g.micro --no-publicly-accessible
# 2. Verify on the restored instance (same credentials as the source secret; host differs)
psql "postgres://mf:<password>@<restored-endpoint>:5432/mf" -c 'select count(*) from jobs'
# 3. Point the app at it: either dump/restore into the stack's instance
pg_dump ... | psql ...                       # small db: simplest, no infra change
#    or rename the instances (stop api first) so the restored one takes the original identifier.
# 4. Update the host in the RDS secret only if the endpoint changed, then restart the api tasks:
aws ecs update-service --cluster <mf-env cluster> --service <api service> --force-new-deployment
```

Delete the restore instance when done — it is billed like the original.

## Rotating keys

### Anthropic API key

```shell
aws secretsmanager put-secret-value --secret-id mf/$ENV/anthropic-api-key --secret-string 'sk-ant-…'
aws ecs update-service --cluster <mf-env cluster> --service <api service> --force-new-deployment
```

The api reads the key once at start-up (`secrets` plugin), so the restart is required; running
jobs keep the old key until they finish (they also read at start-up) — revoke the old key at
Anthropic only after they are done, or kill them.

### JWT signing key (`auth-jwt-private-key`)

Rotating signs everyone out: the public key is served from `/.well-known/jwks.json` and only the
current key is published.

```shell
aws secretsmanager put-secret-value --secret-id mf/$ENV/auth-jwt-private-key \
  --secret-string "$(node scripts/gen-auth-key.mjs)"
aws ecs update-service --cluster <mf-env cluster> --service <api service> --force-new-deployment
```

With two api tasks (live) there is a window during the rolling deploy where tokens minted by one
task are rejected by the other — do it at a quiet hour. If the secret is empty/invalid the api
boots with an **ephemeral** key and logs a warning; that is the "everyone signed out on every
restart" symptom.

### Postgres password

Managed by RDS; rotate with `aws secretsmanager rotate-secret --secret-id <rds-secret-arn>` once
a rotation lambda is attached (not set up yet), or manually: `aws rds modify-db-instance
--master-user-password`, then `put-secret-value` with the updated JSON and restart the api.

### Stripe / GitHub

`put-secret-value` on `mf/$ENV/stripe-secret-key`, `stripe-webhook-secret`, `github-token` and
restart the api; jobs never see these.

## Alert delivery checklist (after the first `ops-<env>` deploy)

1. Each `adminEmails` address receives "AWS Notification — Subscription Confirmation"; click it
   (TODO-EXTERNAL). Until then alarms fire into the void.
2. Activate the `Environment` cost-allocation tag once per account (Billing → Cost allocation
   tags); the budget reads 0 until it is active (up to 24 h).
3. Test the path: `aws cloudwatch set-alarm-state --alarm-name mf-$ENV-jobs-failed
--state-value ALARM --state-reason "runbook test"` → an e-mail should arrive within a minute,
   followed by the OK e-mail when the next evaluation resets it.
