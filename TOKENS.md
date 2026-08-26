# Token ledger — append `/cost` per session

Format: date | milestone | session tokens (in/out) | notes

| date | milestone | in | out | notes |
|---|---|---|---|---|
| 2026-08-26 | planning | ~25k | ~5k | plan + lists written |
| 2026-08-26 | M1 template extraction | ~300k | ~30k | subagent, 61 tool calls, 21 min; lint+68 tests green |
| 2026-08-26 | M1 template infra + CI | ~320k | ~30k | subagent follow-up: resources stack, GitHub Actions |
| 2026-08-26 | M1 monorepo scaffold | ~130k | ~25k | subagent: apps/site+portal+api, packages ×6, infra (2 SPAs), CI; lint+68 tests+build+synth green |
| 2026-08-26 | M1 monorepo scaffold | ~100k | ~10k | subagent: 8 workspaces, 68 tests, 4 stacks synth; CLAUDE.md dedup |
| 2026-08-26 | M1 CDK stack | ~90k | ~15k | subagent: RDS Postgres 17, secrets placeholders, artifacts bucket, mf-jobs cluster + task def, api wiring; 4 stacks synth offline, lint + 68 tests green |
| 2026-08-26 | M1 deploy dev | ~60k | ~6k | bootstrap, resources-dev + mf-dev live; Dockerfile --ignore-scripts fix |
| 2026-08-26 | M1 custom domains | ~45k | ~5k | ACM certs, Route53 records, CloudFront /bff→ALB, dev on mjukvaruhuset.se |
| 2026-08-26 | M1 prod-bundle fix | ~40k | ~5k | sessionSlice import cycle broke SPAs in prod; fixed in site/portal/template, verified headless |
| 2026-08-26 | M2 spec engine | ~190k | ~35k | subagent: models Spec schema, harness engine + estimator (17 tests), api plugins/service/routes (+17 tests → 73), portal spec page sv/en; lint + 110 tests + build + smoke green; live model unverified (key empty) |
| 2026-08-26 | M2 spec engine | ~190k | ~25k | subagent: models/harness/api/portal, 110 tests; infra secret wiring + dev deploy |
| 2026-08-26 | M6 magic-link auth (pulled forward) | ~250k | ~45k | subagent: models User/Org/Auth.api, api authKeys/email/auth plugins + user/auth services + 5 routes (123 api tests, 160 total), portal login/callback/header sv+en, infra secret + SES + config; lint + build + smoke + synth green |
