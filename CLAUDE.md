Read PLAN.md first. Work milestone by milestone, tick boxes only when verified.
Anything needing external approval goes to TODO-EXTERNAL.md, never blocks the road.
Append /cost to TOKENS.md at the end of every session.

## Repository layout

npm-workspaces TS monorepo instantiated from `templates/web` (the golden template — never edit it in place). Conventions, commands and architecture are in `templates/web/CLAUDE.md` and apply here 1:1 with `@template/*` → `@mf/*`; the same rules/agents are mirrored in `.claude/`.

```
apps/site       @mf/site    public site SPA (sv+en), Vite :5175
apps/portal     @mf/portal  customer portal SPA, Vite :5173 (Item demo kept as pattern reference)
apps/api        @mf/api     single Fastify BFF serving both SPAs, :5174
apps/job        @mf/job     build-job container (Fargate): loads a job from Postgres, runs the @mf/harness orchestrator; `npm run job:dev -- <id>` locally
packages/       @mf/models, @mf/utils, @mf/access-control, @mf/harness (spec engine + orchestrator: plan → DAG → Agent SDK workers in worktrees → merge), @mf/db (postgres driver + migrations/, `npm run db:migrate`), @mf/resident (M8 resident agent service for a customer's own AWS account: issues → harness build → PR, cap/pause/audit/metering; docs/RESIDENT.md)
infra/          CDK: resources-<env> + mf-<env> (site + portal + api), envs dev/live in eu-north-1 — not a workspace, `npm i --prefix infra`
infra/resident/ separate CDK app a customer deploys into their account for the resident (`npm i --prefix infra/resident`, `cdk deploy -c repository=owner/name`)
infra/org/      separate CDK app, deployed ONCE into the management account: Customers OU + guardrail SCP for vended customer accounts (docs/backlog/org-accounts.md)
infra/mail/     separate CDK app, deployed ONCE alongside infra/org: inbound MX + SES receiving for mjukvaruhuset.se, forwarded by Lambda
docker-compose.yml  local Postgres 17; `--profile job` builds/runs the job image behind the egress-proxy sidecar
.github/        ci.yml (lint/test/build/synth), deploy.yml → deploy-environment.yml (OIDC)
```
