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

## Stream 6 — billing cost accuracy (HIGH — real revenue bug, evidenced 2026-08-28)
`totalTokens()` (`packages/harness/src/job/types.ts`) weights cache-reads at **0.1×** (their price)
but counts **output at 1×** (Anthropic bills output ~5× input) and **cache-writes at 1×** (billed
1.25×). It's a fine **budget** metric (stops cache-reads blowing the 15M cap), but it is being used
as the **billing** basis (`tokens × 1.5`), which **under-bills output-heavy work**. It also doesn't
reconcile with Anthropic's console: with prompt caching, cache-reads are ~90% of raw tokens, so the
console shows ~8× our number (observed 2026-08-28: console ~250M vs our metering ~30M over two days —
`250/30 ≈ 8`, exactly the cache-read discount; **not a leak, a weighting**).
- Add a `cost(usage, model)` that computes **actual $** from per-model prices (input / output /
  cache-read / cache-write); keep `totalTokens()` for the budget cap **only**.
- Persist the **raw four-bucket usage** (input, output, cache_read, cache_creation) per job/session
  so cost can be recomputed if prices change (today only the weighted scalar is kept).
- Wire `cost()` into resident metering (`residentUsageRecord` → bill `cost × 1.5`, not weighted
  tokens). Reconcile the monthly total against the Anthropic console.
- Areas: `packages/harness` (types.ts `cost()`, usage capture), `packages/models` (usage-record
  shape), `apps/api` (`residentService`/metering).

## Stream 7 — review-gate accuracy (HIGH — failed a good 12M build, evidenced 2026-08-28)
The review gate **false-positived a good build** (`0b5efa32`, family-hub #2, 12.4M weighted tokens)
and failed it closed on three findings that **do not exist in the code**: two claimed users must type
a raw UUID (the app uses `<FamilyMemberSelect>` name pickers backed by `GET /bff/family-members`),
one claimed a reminder never fires at offset 0 (the code uses an **inclusive** bound and comments the
0 case). A gate that hallucinates and burns 12M-token builds is the **most expensive bug we have**.
- The review gate must **verify each finding against the actual code before failing closed** — read
  the cited file/lines and confirm the claim (it is supposed to; here it did not).
- Add an **adversarial refute pass** (like `/code-review`'s verify): each finding gets N skeptics that
  try to disprove it; drop findings that can't be substantiated. Track a false-positive rate.
- The transcript capture shipped this session (debug bundle `transcripts/`) is the raw material for
  auditing what the review session actually did. Areas: `packages/harness/src/job/gates/review*`,
  `gateSessions.ts`.

## Stream 8 — delivery runtime robustness (HIGH — family-hub #2 delivered but 503, 2026-08-28)
The delivery pushed the repo (`github.com/mjukvaruhuset/family-hub`) + built the image + stood up the
Express URL, but the container **crashlooped (exit 1) → 503**. Three real gaps, all evidenced:
1. **Env-contract mismatch (root cause).** The Express deploy injects only the *template's* auth env
   (`AUTH_ISSUER/JWKS_URL/AUDIENCE`), but generated apps evolve their own required env — family-hub's
   `secrets` plugin requires `AUTH_JWT_SECRET` + `VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT` (own JWT +
   web-push) and throws on boot. Delivery can't hardcode the template contract. Fix: the app declares
   its required runtime env (a manifest / `.env.example` the harness emits), and delivery
   **generates/injects** them (VAPID via `web-push` generateVAPIDKeys, a random JWT secret, …) — or
   constrain generated apps to a fixed env contract. The **acceptance gate should boot the built
   container** (it passed in-process yet missed the real-deploy crash).
2. **Express create idempotency false-failure.** `CreateExpressGatewayServiceCommand`
   (`ecsExpress.ts`) sends no clientToken; an SDK retry after a successful create throws "Creation of
   service was not idempotent", so delivery reports `deploy: failed` + `deployUrl: null` **even though
   the service is live**. Pass a deterministic clientToken, or on that error describe + return the
   existing service.
3. **No container logs.** delivery-demo didn't wire the Express `awsLogsConfiguration`, so the boot
   crash was invisible — root-caused only from the stopped task's exit code. Always wire
   `/mf/<env>/express` + a per-service stream prefix (verify the job path does too).
Areas: `packages/harness/src/job/delivery/ecsExpress.ts`, delivery config, harness worker (env
manifest), acceptance gate (boot the container).

## Not in this wave (bigger, separate)
- **Org account vending** ([org-accounts.md](org-accounts.md)) — its own focused build.
- **M11 customer dev/qa/live + resident LLM** ([environments.md](environments.md)) — needs the org
  foundation first + the design decisions locked.
- **Platform qa env** for mjukvaruhuset itself — clean infra task, do when convenient.
