# mjukvarufabriken.se — one-shot software road

Goal: a customer submits a spec, the factory builds it, delivers repo + running URL, customer pays.
Everything that needs someone else's approval lives in TODO-EXTERNAL.md and is NOT on this road.

## Decisions (made 2026-08-26, change here if you disagree)
- Cloud: AWS (CDK for IaC, eu-north-1 Stockholm)
- Agent runtime: Claude Agent SDK (TypeScript), build jobs in Docker on ECS Fargate
- Payment: Stripe Checkout (Klarna/cards come through Stripe). Test mode until live verification clears.
- Stack: TypeScript monorepo (pnpm), Next.js for site + portal, Postgres (RDS), S3 for artifacts
- Auth: email magic link (BankID = later)
- Delivery target: GitHub repo (transferred to customer) + deploy to AWS App Runner with URL
- Languages: sv + en on the public site; portal en first
- Pricing v1: fixed price per accepted spec, 50% deposit before build, 50% on delivery; resident-agent mode = tokens × 1.5 + monthly fee

## You must provide before build starts (hours, not weeks)
- [ ] AWS account, admin IAM user/role for me, billing alert set
- [ ] Anthropic API key with billing (Console) — separate key for the factory
- [ ] GitHub org `mjukvarufabriken` + token with repo/admin scope
- [ ] Stripe account (test-mode keys are enough to build)
- [ ] Domain: check availability of mjukvarufabriken.se and buy it (Loopia/Internet.se). DNS delegated to Route53.
- [ ] Answers to open questions at the bottom of this file

## Milestones (checkbox = done and verified)

### M1 — Skeleton (day 1)
- [ ] Monorepo: `apps/site`, `apps/portal`, `packages/harness`, `packages/db`, `infra/`
- [ ] CI (GitHub Actions): lint, test, build
- [ ] CDK stack: VPC, RDS, S3, ECS cluster, App Runner, secrets
- [ ] TOKENS.md ledger started

### M2 — Spec engine
- [ ] Spec chat → structured spec (JSON schema: goal, users, features, non-goals, acceptance criteria, stack constraints)
- [ ] Clarification loop: agent asks questions until spec passes a completeness check
- [ ] Price estimator from spec (size class S/M/L → fixed price)
- [ ] Spec frozen + signed off in portal before build

### M3 — Orchestrator + sandbox
- [ ] Job = container on Fargate, receives spec + budget, no customer secrets inside
- [ ] Plan → task DAG → parallel Agent SDK workers in git worktrees → merge
- [ ] Hard token budget per job, kill switch, egress allowlist (npm, github, anthropic only)
- [ ] Progress events streamed to DB (portal shows them live)

### M4 — QA gates
- [ ] Tests generated from acceptance criteria and must pass
- [ ] Independent review agent (correctness + security), findings must be fixed or waived
- [ ] Acceptance-check agent: every criterion mapped to evidence
- [ ] Job fails closed: no green gates → no delivery, human notified

### M5 — Delivery
- [ ] GitHub repo created, README + handover doc, transferred to customer
- [ ] Deployed to App Runner, URL in portal
- [ ] Deliverable bundle in S3 (repo zip, docs, test report)

### M6 — Portal + payment
- [ ] Magic-link auth, org/user model
- [ ] Order flow: new order → spec chat → freeze → Stripe deposit → build → deliver → Stripe balance
- [ ] Live job progress, deliverables, invoices (Stripe-hosted), token usage
- [ ] Admin view: all jobs, budgets, kill switch

### M7 — Public site
- [ ] Landing, how it works, pricing, contact — sv/en
- [ ] Built THROUGH the harness (first case study)

### M8 — Resident agent mode
- [ ] Deploy agent into customer's AWS account (CDK template) with scoped IAM + customer's own Anthropic key or metered via ours
- [ ] Monthly token cap, pause button, audit log of every action
- [ ] Metering → Stripe usage-based billing

### M9 — Ops
- [ ] Logs + alerts: token burn per job, failed jobs, cost anomalies
- [ ] Backups (RDS automated), incident runbook
- [ ] Security baseline: secrets in Secrets Manager, least-privilege IAM, dependency scanning

### M10 — Proof
- [ ] Dogfood: 3 internal apps built end-to-end from spec, results logged in TOKENS.md
- [ ] Pilot-ready: contract drafts in `legal/` (unreviewed until TODO-EXTERNAL clears)

## Open questions (answer inline)
1. Company/brand name on site while AB is pending — "Mjukvarufabriken" as trade name OK?
2. Price points for S/M/L? (proposal: 15k / 45k / 120k SEK ex moms)
3. Which repo host for customers who don't have GitHub — zip only, or also GitLab?
4. Resident agent v1: customer's own Anthropic key (simplest, no metering risk) or ours (margin)? Proposal: theirs in v1.
5. Portal in Swedish too in v1, or en only?
