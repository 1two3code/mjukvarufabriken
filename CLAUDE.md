Read PLAN.md first. Work milestone by milestone, tick boxes only when verified.
Anything needing external approval goes to TODO-EXTERNAL.md, never blocks the road.
Append /cost to TOKENS.md at the end of every session.
After any harness job run (dogfood or customer, success or failure): append every defect it
surfaced to docs/LEARNINGS.md and sweep that file's OPEN entries before starting the next paid run.

## Git workflow

`main` is branch-protected on GitHub (`enforce_admins: true`, no force-push, no deletion, PR
required — since 2026-08-30). A direct `git push … main` is rejected for everyone, owner included:
push your branch and open a PR (`gh pr create`), then merge it — no required reviewer count, so a
solo session can merge its own PR once checks are green.

Enter an isolated git worktree (`EnterWorktree`, or plain `git worktree add`) at **session start**
and stay in it for the whole session — one worktree per session, PR branches come and go inside it.
Several sessions run here concurrently, so the shared checkout is read/sync-only: never work or
idle there; touch it only to fast-forward main (`git -C <root> pull --ff-only`). `templates/web`
is a separate npm project (not a root workspace): a fresh worktree needs its own
`npm i --prefix templates/web` before `packages/harness`'s offline e2e tests (which hard-link its
`node_modules` to seed a simulated job) will pass.

This exists because of a real incident (2026-08-30): a harness e2e test's child `git` processes
inherited `GIT_DIR`/`GIT_WORK_TREE` from a running pre-push hook and redirected its throwaway seed
commits onto `main`, which then got pushed for real. Fixed in `packages/harness/src/job/exec.ts`
(`sandboxEnv` strips git's repository-location env from every child process) — branch protection is
the second layer, so a similar bug in something else can't do the same thing silently again.

## Repository layout

npm-workspaces TS monorepo instantiated from `templates/web` (the golden template — never edit it in place). Conventions, commands and architecture are in `templates/web/CLAUDE.md` and apply here 1:1 with `@template/*` → `@mf/*`; the same rules/agents are mirrored in `.claude/`.

```
apps/site       @mf/site    public site SPA (sv+en), Vite :5175
apps/portal     @mf/portal  customer portal SPA, Vite :5173
apps/api        @mf/api     single Fastify BFF serving both SPAs, :5174
apps/job        @mf/job     build-job container (Fargate): loads a job from Postgres, runs the @mf/harness orchestrator; `npm run job:dev -- <id>` locally
packages/       @mf/models, @mf/utils, @mf/access-control, @mf/harness (spec engine + orchestrator: plan → DAG → Agent SDK workers in worktrees → merge), @mf/db (postgres driver + migrations/, `npm run db:migrate`), @mf/resident (M8 resident agent service for a customer's own AWS account: issues → harness build → PR, cap/pause/audit/metering; docs/RESIDENT.md)
infra/          CDK: resources-<env> + mf-<env> (site + portal + api), envs dev/live in eu-north-1 — not a workspace, `npm i --prefix infra`
infra/resident/ separate CDK app a customer deploys into their account for the resident (`npm i --prefix infra/resident`, `cdk deploy -c repository=owner/name`)
infra/org/      separate CDK app, deployed ONCE into the management account: Customers OU + guardrail SCP for vended customer accounts (docs/backlog/org-accounts.md)
infra/mail/     separate CDK app, deployed ONCE alongside infra/org: inbound MX + SES receiving for mjukvaruhuset.se, forwarded by Lambda
infra/status/   separate CDK app, deployed ONCE: Uptime Kuma (Fargate + EFS) behind status.mjukvaruhuset.se, monitoring dev/portal.dev/api.dev
docker-compose.yml  local Postgres 17; `--profile job` builds/runs the job image behind the egress-proxy sidecar
.github/        ci.yml (lint/test/build/synth), deploy.yml → deploy-environment.yml (OIDC)
```
