# Self-hosted / SaaS tool adoption review

> **STATUS 2026-08-30:** research done (3 parallel investigations against the actual codebase, not
> generic tool praise), verdicts below. 3 of ~15 real candidates clear the bar right now — Trivy,
> Sentry, Uptime Kuma. Everything else is a genuine, reasoned "skip, revisit when X" rather than a
> blanket no. The 3 adopt-now items are streams in the wave-11 ultracode run (see PLAN.md); nothing
> here has been built yet as of this commit.

Source: [The Factory Parts Catalog](https://claude.ai/code/artifact/bca20f78-3aad-47a7-bc06-64b63b891a87)
(built earlier this session from Fireship's sponsor roster + selfh.st/apps, itself already filtered
for relevance). This document is the next filter pass: given what mjukvaruhuset *actually* is today
— solo founder, pre-revenue, AB not yet registered, small real infra footprint — which of those
still make sense, and why.

## Adopt now

**Trivy** (OSS, CI step) — CI has `npm audit` (dependency vuln counts) but nothing scans the built
`api`/`job` Docker images for OS-package CVEs, notable since `job` runs untrusted customer
workloads and `api` holds real secrets. One CI step, allow-fail like the existing audit convention,
~1–2 hours.

**Sentry** (SaaS free tier, *not* self-hosted) — self-hosted Sentry needs its own
Postgres+ClickHouse+Redis+Kafka, wrong fit for a solo operator; the free SaaS tier (5k events/month)
gets ~90% of the value with none of that weight. Real gap: zero error tracking today beyond raw
CloudWatch logs and the 9 existing alarms, none of which carry a stack trace. `@sentry/node` in
`apps/api`, `@sentry/react` in `apps/site`/`apps/portal`, DSN as a per-env secret. ~2–4 hours.

**Uptime Kuma** (OSS, single container) — no public status page exists for
`dev.mjukvaruhuset.se`/portal/api. Lightweight, SQLite-backed, purely additive, no existing app code
touched. Best cost-to-value of everything evaluated. ~half a day including the `status.` subdomain
and 3 monitors.

## Adopt later (real fit, wrong time)

**PostHog** — the funnel/session-replay question ("where do customers drop off in spec-chat") is
real, but there's no real customer traffic yet to analyze. Revisit once M10 dogfooding + first
paying customers land.

**Documenso** — real fit exists (`kundavtal`/`PUB-avtal`/SLA sit as DRAFT-unsigned in `legal/`,
waiting on lawyer review), but there's no signed customer yet and the drafts aren't even
lawyer-cleared. A plain emailed PDF is legally adequate at this scale. Revisit the moment there's a
real pilot to sign — cheap to stand up when needed (~1–2 hrs), no reason to front-load it.

**Netdata** — Fargate tasks are ephemeral/managed (no host to install an agent on); CloudWatch
Container Insights already covers container-level metrics there. Its real fit is a long-lived host
you SSH into — which doesn't exist today, *except* the separately-noted "dedicated always-on Ubuntu
dev server" side-quest is exactly that. Revisit only if that box gets built.

## Skip (checked, genuinely doesn't fit — not just "haven't gotten to it")

- **Grafana + Prometheus** — overlaps the existing, working CloudWatch alarm setup; standing up
  Prometheus needs a scrape target CloudWatch doesn't natively expose, plus its own always-on TSDB
  storage. If a real dashboard need emerges, Apache Superset sits directly on the Postgres already
  in use — no separate metrics pipeline required.
- **Coder** — no demonstrated need (one developer, working locally); M11's customer dev-env is a
  different problem (per-customer hosted server) even once it's built. Revisit only with a real team.
- **Infisical** — Secrets Manager already works and is IAM-wired; would be a second secrets system
  for a marginal win over the current `.env` + Secrets Manager split. Revisit if secret sprawl or
  multi-developer local-secret-sharing becomes a real pain.
- **Flipt** — no staged-rollout need exists; every feature so far (GitHub sign-in, account
  provisioning) shipped fine behind a plain env-var flag. Revisit only if M11's per-customer
  environments create a real "roll out to some customers, not others" scenario.
- **Cal.com** — no active sales/onboarding call volume yet (GitHub org doesn't exist, Stripe is
  still test-mode, pricing is still being redesigned). A calendar link costs nothing; running an
  instance for zero bookings is pure overhead. The "offer it as a customer-app template" idea is a
  separate product-feature question, not an infra-adoption one.
- **Chatwoot** — `hej@mjukvaruhuset.se` doesn't exist yet, and contact-form mail already routes to
  `AUTH_ADMIN_EMAILS` via SES — a working, zero-setup channel for ~0 messages/week today. Not worth
  its own Postgres/Redis/SMTP-IMAP stack until there's real ticket volume.
- **Docmost** — not just "not yet," actively works against how this project runs: `PLAN.md`/
  `docs/backlog/*.md` are deliberately git-native, agent-read/written, and PR-reviewed (this session
  alone added ~5 new backlog docs this way). A separate wiki app breaks that loop for no gain — the
  bottleneck was never human wiki-browsing.
- **Retool** — directly redundant with the native `/admin` portal work already in progress this same
  session (Customers table, Model Prices panel, routed admin sections, M12 margin calculator). Would
  mean maintaining two admin surfaces, plus it's a paid SaaS on top of that.
- **n8n** — checked the three concrete candidates (nightly token-ledger posting, SNS alert routing,
  SES-sandbox-approval polling): none is big or frequent enough to justify a full workflow platform
  with its own Postgres/auth/UI. A five-line cron script covers the one real recurring task.
- **Apache Superset** — directly overlaps M12 (the margin calculator), already scoped and being
  built natively in the admin portal. Its operational weight (Flask/Redis/Celery/its own auth) is
  disproportionate to one well-defined dashboard need already in progress.

## How this feeds the plan

The three "adopt now" items are streams in the wave-11 ultracode run alongside the admin refactor,
M12 backend, the verification sweep, job-isolation hardening, repo/portal hygiene, org-accounts
wiring, and the pricing config table (see `PLAN.md`). Each opens its own PR for review — none
merges to `main` automatically. "Adopt later" items are intentionally not scheduled; re-evaluate
each against its stated trigger condition rather than on a timer.
