# Wave 7 — the next ultracode plan (draft 2026-08-28)

Context: the one-shot factory is live-verified end to end (M1–M6 minus real Stripe; M5 delivery proven
against real AWS — repo→CodeBuild→ECR→ECS Express→200). This wave hardens the customer-facing product
and closes the gaps the live delivery surfaced. Same wave mechanics as waves 1–6 (builder → 3 reviewers
→ fixer → merge, offline e2e stays the gate). Streams are disjoint areas.

Priorities, highest first. Hasse: say if you'd reorder or drop any.

## Stream 1 — stripe-klarna (needs Hasse's test keys to fully verify; code is unblocked)
Brief: [stripe-klarna.md](stripe-klarna.md). Handle Klarna's async payment events, verify the real
provider in test mode, invoices, explicit payment methods. The code + tests are buildable now; the live
test-mode run waits on the Stripe keys.

## Stream 2 — delivered-frontend-visible (the gap the e2e exposed)
Today delivery pushes the SPA build to a **private** S3 prefix — so a delivered *frontend* app has no
public URL to visit (the ECS Express URL serves the API only). Make a delivered app actually visitable:
- **Static / no-backend apps → S3 + CloudFront** (a per-delivery public distribution), the decided path.
- **Full-stack apps** → keep the ECS Express API + serve the SPA (either the api serves its built static
  files as one URL, or the SPA on CloudFront calls the API). Pick one and make delivery choose by whether
  the spec has a backend. The portal deliverables view shows the visitable URL.
Areas: `packages/harness/src/job/delivery/*`, `infra` (per-delivery CloudFront or a shared one),
`apps/portal` (show the site URL).

## Stream 3 — delivered-repo-hygiene (option 2, decided 2026-08-28)
The delivered customer repo ships OUR CI/deploy workflows (OIDC into our account). Strip/replace
`.github/workflows` during delivery with a customer-appropriate **lint+test CI only** (no deploy
workflow) — then the GitHub App's `workflows` permission is no longer needed either. Areas:
`packages/harness/src/job/delivery/*` (a curate-repo step before push).

## Stream 4 — efficiency + ops
- **Worker token efficiency** with REAL data now (the human-e2e job + runs #13–#21): measure where turns
  go, tighten (scoped gate, cap tuning). `packages/harness`, `docs/EFFICIENCY.md`.
- **Job liveness sweep** (M9): a job whose Fargate task dies before claiming its token stays `queued`
  forever — the api periodically `ecs:DescribeTasks` for active jobs and marks `failed` on STOPPED.
  `apps/api`, `packages/db`.

## Stream 5 (optional, product) — approve-before-deliver
A human-in-the-loop gate: green gates → the portal shows the diff + gate reports + preview URL and the
customer/admin **approves** before the repo transfers / goes live. Big trust win for real customers.
Areas: `apps/api` (an `awaiting_approval` job/order state + approve route), `apps/portal`.

## Not in this wave (bigger, separate)
- **Org account vending** ([org-accounts.md](org-accounts.md)) — its own focused build.
- **M11 customer dev/qa/live + resident LLM** ([environments.md](environments.md)) — needs the org
  foundation first + the design decisions locked.
- **Platform qa env** for mjukvaruhuset itself — clean infra task, do when convenient.
