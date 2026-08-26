Read PLAN.md first. Work milestone by milestone, tick boxes only when verified.
Anything needing external approval goes to TODO-EXTERNAL.md, never blocks the road.
Append /cost to TOKENS.md at the end of every session.

## Repository layout

npm-workspaces TS monorepo instantiated from `templates/web` (the golden template — never edit it in place). Conventions, commands and architecture are in `templates/web/CLAUDE.md` and apply here 1:1 with `@template/*` → `@mf/*`; the same rules/agents are mirrored in `.claude/`.

```
apps/site       @mf/site    public site SPA (sv+en), Vite :5175
apps/portal     @mf/portal  customer portal SPA, Vite :5173 (Item demo kept as pattern reference)
apps/api        @mf/api     single Fastify BFF serving both SPAs, :5174
packages/       @mf/models, @mf/utils, @mf/access-control, @mf/harness (orchestrator stub, M3), @mf/db (Postgres stub + migrations/)
infra/          CDK: resources-<env> + mf-<env> (site + portal + api), envs dev/live in eu-north-1 — not a workspace, `npm i --prefix infra`
.github/        ci.yml (lint/test/build/synth), deploy.yml → deploy-environment.yml (OIDC)
```
