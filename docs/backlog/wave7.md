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

## Stream 2 — delivered-frontend-visible ✅ core done 2026-08-28 (commit 1ca1ac4)
The delivered ECS Express service now serves the built SPA at `/` and the BFF under `/bff`
(`registerSpa` + a multi-stage api Dockerfile that builds the SPA), so the delivered URL shows
the actual website and the portal's `deployUrl` link is the visitable site. Verified with a real
docker build + container smoke and the offline e2e. Remaining (optional, this wave):
- **Static / no-backend apps → S3 + CloudFront** so a purely-static site isn't served by a
  Fargate container (cost/CDN). The api-serves-SPA path already covers full-stack + static for v1.
- Rename the portal "preview" label to "Your site"; optionally drop the now-redundant private-S3
  `uploadSite` step (kept only as a downloadable bundle artifact).
Areas: `packages/harness/src/job/delivery/*`, `infra` (CloudFront), `apps/portal`.

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
