# Mjukvaruhuset — due diligence, 31 August 2026

A full review of what has been built since the repository was created on **2026-08-26** — six days
ago. "The last week" is therefore the entire project. Sources: all 66 pull requests and the full
commit history on `main`, `PLAN.md` (the living milestone plan), `TOKENS.md` (the per-session
ledger), `TODO-EXTERNAL.md`, the 61-finding adversarial hardening audit
(`docs/backlog/hardening-2026-08-30/`), the Phoenix and org-accounts runbooks, and the
live-verification notes recorded against each milestone.

**Verification levels used throughout** — this distinction is the core of the review:

- **LIVE** — exercised for real (deployed AWS environment, real money in test mode, real Fargate
  run, or a human clicking through) and confirmed working.
- **CODE** — implemented with unit/synth tests green, but never yet run against the real thing.
- **PARTIAL** — some of the milestone is LIVE or CODE, the rest missing.
- **NOT STARTED** — exists as a written plan only.

---

## 1. The goal

**A customer submits a spec; the factory builds the software; the customer gets a GitHub repo plus
a running URL; the customer pays.** Brand: *Mjukvaruhuset* (mjukvaruhuset.se), Swedish + English
from v1, operating from Stockholm (AWS eu-north-1).

The machine behind that sentence:

1. **Spec engine** — a chat that turns a customer's idea into a structured, complete spec
   (goal, users, features, acceptance criteria), priced by size class, frozen before build.
2. **Order flow** — Stripe Checkout deposit (50 %), which auto-starts the build; balance on
   delivery. Sweden-first: card + Klarna, 25 % moms itemized, own merchant-of-record.
3. **Build factory** — a Fargate container per job runs an orchestrator: plan → task DAG →
   parallel Claude Agent SDK workers in isolated git worktrees → merge → five quality gates
   (generated acceptance tests, adversarial review, licence scan, acceptance evidence check,
   fail-closed delivery) with a repair loop. Hard token budget, kill switch, egress allowlist,
   two-uid sandbox.
4. **Delivery** — private GitHub repo (handover docs, test report, clean customer CI), deployed
   to a live HTTPS URL (CodeBuild → ECR → ECS Express Mode), deliverable bundle in S3, all
   surfaced in a customer portal.
5. **Resident agent** (later revenue) — an agent deployed into a customer's own vended AWS
   account that turns issues into PRs, metered at tokens × 1.5 + monthly fee.

**Business model status:** the original S/M/L pricing (15k / 45k / 120k SEK) is under active
revision toward a low-risk ladder — free tier → ~few-hundred-SEK demo → loss-leader MVP top-up →
$300–500 mid-tier → an edits subscription — with a hard ceiling of **5 000 SEK** for now. This is
explicitly *not decided*, and nothing is built against it yet.

**Multi-tenancy model (decided):** an AWS Organization; every customer gets a vended member
account we operate (account-per-customer), guardrailed by SCP; consolidated billing meters per
account. Our own platform is mid-move out of the management account ("Phoenix").

---

## 2. Where it stands — the verdict

**The core promise has been demonstrated end-to-end on dev, once, for real.** A guestbook app went
spec → plan → parallel workers → all five gates green → private repo → ECR image → live HTTPS URL
returning correct responses (2026-08-30). Real test-mode money (card *and* Klarna) has flowed
through checkout and auto-started a build. That is remarkable for six days of work.

**What separates this from a business today is not the pipeline — it is three things:**

1. **Trust gates the team defined for itself and hasn't cleared yet.** A 61-finding adversarial
   audit (run 2026-08-30) sorted into three go/no-go gates: Gate A (before deploying `live`) is
   12/16 fixed; Gate B (before untrusted customers) is 3/9 fixed; Gate C (before trusting
   *unattended* delivery quality) is untouched. Two standing bans are in force and correct:
   **do not deploy live; do not onboard untrusted customers.**
2. **The paperwork.** No AB, no F-skatt, no bank account, therefore no Stripe live mode — nothing
   can legally be invoiced. All queued in TODO-EXTERNAL with week-scale lead times.
3. **Proof and pricing.** Zero external users; the M10 dogfood run (3 internal apps through the
   factory) hasn't started; the pricing model the business will actually sell is undecided.

Nothing found in this review contradicts the project's own bookkeeping — PLAN.md's checkboxes,
verification claims, and open items match the commit history and PR record. The internal
documentation habit (every claim tagged live-verified vs code-verified, every judgment call
written down) is unusually good and materially lowers project risk.

---

## 3. What exists, milestone by milestone

| Milestone | Status | Evidence / gap |
|---|---|---|
| M1 Skeleton (monorepo, CI, CDK, dev env) | **LIVE** | dev deployed on mjukvaruhuset.se; first green CI + OIDC deploy from GitHub 2026-08-30 |
| M2 Spec engine (chat → spec → freeze → price) | **LIVE** | exercised by the real orders that ran; estimator unit-tested (sv+en) |
| M3 Orchestrator + sandbox (Fargate, DAG, budget, kill, egress) | **LIVE** | 13+ real Fargate runs, each surfacing a real defect since fixed; budget abort + kill verified |
| M4 QA gates (tests, review, licence, acceptance, fail-closed) | **LIVE** | job `5e894e2a` all five gates green; licence + ops gates live-verified on dev 2026-08-30 (#43) |
| M5 Delivery (repo, docs, deploy, bundle) | **LIVE** | guestbook delivered end-to-end: repo + S3 bundle + CodeBuild→ECR→ECS Express URL, HTTP 200/201 |
| M6 Portal + payment (auth, orders, Stripe, admin) | **LIVE** (test mode) | magic link + GitHub sign-in live; card+Klarna deposit → auto build start verified; **balance-on-delivery leg and Stripe live mode pending** |
| M7 Public site (sv/en, legal pages) | **LIVE** | deployed; *not yet rebuilt through the factory* (that's dogfood app #1) |
| M8 Resident agent | **CODE** | full service + own CDK app + cap/pause/audit/metering, fakes + synth only; **never deployed to a real customer account**, Stripe meter unbilled |
| M9 Ops (liveness sweep, alarms, backups, TLS, Sentry) | **PARTIAL→LIVE** | alarms confirmed on dev, liveness + ops live-verified 2026-08-30; Sentry wired but DSNs unset; status page synth-only |
| M10 Proof (3 dogfood apps, pilot-ready) | **NOT STARTED** | app #1 decided (rebuild own site), app #2 specified (bakery, classifies L), app #3 unpicked; legal drafts exist but unreviewed |
| M11 Environments | **PARTIAL** | platform dev→qa→live: **qa account vended, deployed, endpoints 200** (2026-08-30/31); live account not vended. Customer-side dev/qa/live: design notes only |
| M12 Margin calculator | **PARTIAL** | real per-job USD cost persisted + editable model prices + backend (#46) done; revenue model + margin UI wait on the pricing decision |

Supporting assets beyond the milestones: five separate CDK apps (platform, resident, org, mail,
status), inbound catch-all mail on mjukvaruhuset.se (live), the `templates/web` golden template,
an offline e2e + record/replay harness for the orchestrator, and legal draft agreements in
`legal/` (marked EJ GRANSKAD).

---

## 4. The week in numbers

- **6 days** from empty repository to a delivered, live-URL application.
- **66 PRs** (62 merged), **1 175 tests green**, 18 DB migrations, 8 workspaces + 5 CDK apps.
- Built largely by **11+ multi-agent "ultracode" waves** (parallel isolated worktrees →
  adversarial verification → gated merge), ≈ **40 M orchestration tokens** total per the
  TOKENS.md ledger, plus a 182-agent / 10.2 M-token audit pass.
- **Real build economics measured:** ≈ USD 2.5 per M budget-tokens; a mid-size job ≈ USD 6.5 /
  44 min; total real Anthropic spend on actual factory runs so far on the order of USD 60–70.
- Three real deliveries: the first green delivery (`5e894e2a`), family-hub (salvaged from a
  false-positive review-gate failure), and guestbook (fully live-verified URL).

---

## 5. Security posture

The platform runs untrusted, customer-spec-driven AI agents with Bash access — the audit treated
it that way. Current defenses in depth: two-uid sandbox (`setpriv`, env scrubbed key-by-key),
tinyproxy egress allowlist sidecar, per-job one-shot report tokens (job never holds DB creds),
per-job self-scoped STS for S3 uploads, tamper-proof alarm metrics, spec fenced as untrusted data
in every prompt, GitHub token out of argv, and — as of last night — the worker sandbox **never
holds the real Anthropic key** (a loopback forward proxy injects it).

The 2026-08-30 adversarial audit produced **61 verified findings** in three gates:

| Gate | Meaning | Status |
|---|---|---|
| **A** — before `deploy.sh live` | infra blast radius (worst: a bare live deploy landing in the org **management account**) | **12/16 fixed**; open: F3, H1 (needs a real IAM change), real live domain/cert |
| **B** — before untrusted customers | credential exfil chain around the shared API key | **3/9 fixed** (incl. the root cause A1); open: **C1** hard egress fence, **D1** spend metering at the proxy, A2 secret scanner, per-job STS tenant isolation |
| **C** — before trusting unattended delivery | product correctness (guestbook 401 half-fix, `publicUrls` never updated, merges trusted on git exit code, liveness sweep blind to `task_arn IS NULL`) | **0/30 — untouched** |

Two standing bans in PLAN.md are in force: **no live deploys** until Gate A closes; **no untrusted
customers** until B's C1 + D1 close. Both are the right call.

One real incident (2026-08-30): a pre-push hook leaked `GIT_DIR` into a harness e2e's child
processes and pushed garbage to `main`. Recovered same day; fixed at the root (env stripping in
`exec.ts`) plus branch protection as a second layer. The response pattern — root-cause fix +
independent guardrail — is the right one.

---

## 6. What is missing

### Engineering (in rough dependency order)

1. **Gate C** — the delivery-quality findings. This is the product: "a URL that works" currently
   needs a human spot-check (the guestbook needed a manual salvage; delivered SPAs aren't
   render-verified; no DB is provisioned for apps that need one; merge trusts git's exit code).
2. **Gate B remainder** — hard egress fence (own SG/task, deny-by-default), spend metering at the
   new forward proxy, secret scan of delivered artifacts, per-job STS session tagging.
3. **M10 dogfood ×3** — zero runs so far. App #1 (rebuild own site) is cheap and would exercise
   Gate C's surface for real. Note the tension: app #2 (bakery) classifies **L** under the
   estimator the new pricing direction wants to retire.
4. **Live environment** — vend `mjukvaruhuset-live`, finish Phoenix steps 4–7, close Gate A's
   remainder, provision the real domain/cert, deploy.
5. **Pricing decision → implementation** — the ≤5 000 SEK ladder is a strategy note, not a
   product; it blocks the M12 revenue model, the order-flow shape at small ticket sizes, and
   what dogfooding should even validate.
6. **Customer dev/qa/live** (M11 iteration 1–2) — delivery currently produces one environment;
   the dev-env live-edit LLM and portal promotion flow (with customer-side roles) are design-only.
7. **Resident agent in the wild** — first real deployment into a vended account, one real
   metered + invoiced month.
8. **Smaller**: balance-on-delivery payment leg, Sentry DSNs, status-page deploy, alarms→live.

### External / business (all queued in TODO-EXTERNAL, none block engineering)

- **Company formation chain:** AB registration → F-skatt/moms → bank account → **Stripe live
  verification** → first real payment possible. 2–6 weeks of lead time; nothing started can be
  invoiced until it lands.
- **AWS SES production access** (customer email is silent by design until then), Anthropic
  rate/spend limits, Fargate/ECS quotas, cost-allocation tag activation.
- **GitHub**: OAuth App per env for sign-in; the delivery App's permanent org home.
- **Legal**: lawyer review of the four draft agreements; ansvarsförsäkring; trademark check.

---

## 7. Risks worth naming

1. **Zero external validation.** Every verification so far was by the builder. The factory has
   never met a customer, a hostile spec, or a payment dispute. The M10 dogfood milestone exists
   precisely for this and hasn't run.
2. **Pricing strategy is unresolved** while the sales collateral, estimator, and order flow all
   still encode S/M/L. Deciding late is fine; building more against the old ladder isn't.
3. **The platform still lives in the org management account** (Phoenix half-done). Gate A's
   worst finding — a live deploy landing there — is now blocked in code, but the underlying
   exposure remains until qa/live/dev are fully evacuated.
4. **Unattended delivery quality** (Gate C) is the gap between "impressive demo" and "product".
   At the planned cheap-tier volume, per-delivery human QA won't scale.
5. **Unmetered spend paths**: a worker can still hit the forward proxy directly, invisible to the
   budget kill-switch (D1) — bounded today by trusted-only specs, not by enforcement.
6. **Solo-operator process risk**: many autonomous sessions run concurrently against one repo.
   The 08-30 incident shows both that the guardrails work and why they must keep being added
   ahead of need rather than after.

---

## 8. Recommended order of work

1. **Decide the pricing ladder** (a decision, not a build) — it unblocks M12, the order flow,
   and makes dogfooding validate the actual product.
2. **Run dogfood app #1** (site rebuild through the factory) — cheapest real end-to-end signal,
   directly exercises Gate C's surface, produces the first case study.
3. **Close Gate C's systemic fixes + Gate B's C1/D1** — pure engineering, no external
   dependencies, and the precondition for everything customer-facing.
4. **In parallel, start the paperwork chain now** (AB → Stripe live) — longest lead time,
   zero engineering cost.
5. **Vend live + finish Gate A + deploy live** once 3 is done.
6. **First paid pilot** on the cheap tier, with the resident as the follow-on upsell.

---

*Prepared 2026-08-31 from the repository at commit `f6f6cdd` (origin/main). Canonical markdown:
`docs/DUE-DILIGENCE-2026-08-31.md`.*
