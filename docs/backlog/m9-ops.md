# Stream: m9-ops — logs, alerts, backups, security baseline (PLAN.md M9)

Areas: `infra/` (lib, bin, config), `.github/` (workflows, dependabot), `docs/RUNBOOK.md`.
Do not touch apps or packages. `cd infra && npx cdk synth` must stay green offline; do NOT
deploy (`infra/scripts/deploy.sh` is off limits in this stream — the main session deploys).

## Context
Stacks: `resources-<env>` (VPC, RDS Postgres 17, artifacts bucket, secrets, ECS jobs cluster +
job task def with egress-proxy sidecar, log group `/mf/<env>/jobs`) and `mf-<env>` (site +
portal CloudFront, api on Fargate behind an ALB, log group for the api). Envs dev/live in
eu-north-1, config in `infra/lib/config.ts` (has `adminEmails`). Job events are JSON log lines
with `"message":"event <type>"` and `tokensUsed`; job failures log `"event failed"`.

## Deliverables
1. **Alerts** (new `infra/lib/ops-stack.ts` or inside the existing stacks — pick what keeps the
   cross-stack references simple): SNS topic `mf-alerts-<env>` with email subscriptions for
   `adminEmails` (subscription confirmation is manual → TODO-EXTERNAL row). Alarms:
   - failed jobs: metric filter on `/mf/<env>/jobs` for `"event failed"` → alarm on ≥ 1 in 5 min;
   - token burn: metric filter extracting `tokensUsed` from `"job finished"` lines → alarm when
     a job exceeds a per-env threshold (`config.alerts.jobTokensThreshold`, default 20M);
   - api 5xx rate on the ALB (≥ 5 in 5 min) and unhealthy target count;
   - RDS CPU > 80 % 15 min, free storage < 2 GB, free memory low;
   - NAT gateway bytes out anomaly (cost) — CloudWatch anomaly detection or a plain threshold;
   - AWS Budgets: monthly cost budget per env with 80 %/100 % notifications to the topic
     (`config.alerts.monthlyBudgetUsd`).
2. **Backups**: RDS automated backups retention 7 days (dev) / 30 days (live), deletion
   protection in live, snapshot-on-delete; artifacts bucket versioning + lifecycle (expire
   noncurrent versions after 90 days). Verify in synth output.
3. **Security baseline**: confirm every secret is in Secrets Manager (no plaintext env in task
   defs — grep the synthesised templates and fix anything found); least-privilege review of the
   api and job task roles (write what each action is for as a comment); `.github/dependabot.yml`
   (npm for root + infra + templates/web, weekly, grouped) and an `npm audit --audit-level=high`
   step in `ci.yml` (allow-fail for now with a comment, because transitive advisories would
   block the road); CloudFront security headers (HSTS, X-Content-Type-Options, frame-ancestors
   none for the portal) via a response headers policy.
4. **Runbook** `docs/RUNBOOK.md`: where logs are, how to read a job's events, how to kill a job
   (portal admin button or `aws ecs stop-task`), how to roll back a deploy (`cdk deploy` of the
   previous commit; ECS keeps the old task set under minHealthyPercent), what each alarm means
   and the first thing to check, RDS restore steps, rotating the Anthropic key / JWT key.
5. PLAN.md M9: tick the three boxes with date + notes (deploy is verified by the main session;
   note "synth-verified, deploy pending").

## Verification
- `npm i --prefix infra` if needed, `cd infra && npx cdk synth` green for both envs, plus
  `npx cdk diff resources-dev mf-dev` output pasted (trimmed) into the report so the main session
  knows what the deploy will change.
