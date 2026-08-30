# Hardening audit — 2026-08-30

Four adversarial ultracode sweeps (find → refute-verify → synthesize) across the platform, run
after qa was stood up and before pointing anything at live. **61 findings survived adversarial
verification.** These are findings, not changes — nothing in this pass touched code.

| # | Sweep | Confirmed | Critical | High | Report |
|---|-------|-----------|----------|------|--------|
| 1 | Delivery quality (the "URL that works" promise) | 17 | 3 | ~9 | [1-delivery-quality.md](1-delivery-quality.md) |
| 2 | Provisioning / go-live | 23 | 4 | 12 | [2-provisioning-golive.md](2-provisioning-golive.md) |
| 3 | Platform security (multi-tenant runtime) | 8 | 2 | 3 | [3-platform-security.md](3-platform-security.md) |
| 4 | Orchestrator correctness | 13 | 0 | 5 | [4-orchestrator-correctness.md](4-orchestrator-correctness.md) |

Each report has severity, `file:line`, a concrete failure/exploit scenario, and a proposed fix per
finding, plus per-sweep systemic fixes that close whole classes.

## Cross-sweep priority — what actually gates real use

The findings sort into three gates. You cannot safely do the thing in each header until its items
are fixed.

### GATE A — before pointing `deploy.sh` at LIVE (infra blast radius)
- **A1 (S2 crit)** `deploy.sh live` with no `.env.live` resolves creds from root `.env` and deploys
  production into the **org management account** `814967776290`, silently. Fail-closed on
  management/unresolved account. *Do first.*
- **F1 (S2 crit)** live RDS `deletionProtection:true` → a mid-stack failure on the first live deploy
  wedges the stack in `ROLLBACK_FAILED`. Deploy protection-off first, flip after (or isolate RDS).
- **E1 (S2 crit)** random non-empty placeholder secrets defeat the `required in live` boot guard →
  live boots on junk Stripe/Anthropic keys. Seed empty or validate shape at boot.
- **B1 (S2 crit)** live has no `domain` but `transport:'ses'` + no githubOAuth → magic-link dead →
  sole admin locked out of production. Add live domain + SES identity; guard live to require a domain.
- **F2/F3, E2, C1/C2, B2/B3, H1 (S2 high)** — retry-blocking fixed names, fail-open key regen,
  non-ISSUED cert latch, plaintext-ALB token leak, 3600s token aborting a cold deploy.
- **Systemic:** one preflight `--check` gate closes A1/B/C2/E1/F at deploy time; make provisioning
  fail-closed (it currently swallows DNS-delegation + cert-wait failures yet prints "✅ applied").

### GATE B — before onboarding UNTRUSTED customers (security)
One chain, live today (all Sweep 3):
- **A1 (crit)** shared `ANTHROPIC_API_KEY` is the one credential not stripped from the untrusted
  worker sandbox (bypassPermissions + Bash, prompt built from the customer spec).
- Three open exits for it: **A2 (crit)** no secret scan of delivered artifacts (pushed to the
  customer's repo); **C1 (high)** egress "allowlist" is convention-only, `curl --noproxy '*'` walks
  out; **D1 (med)** direct `curl api.anthropic.com` is invisible to the budget kill-switch.
- **B1 (high)** the security-review gate is disarmable by the same spec (raw spec injected unfenced
  into the skeptic prompts).
- **A3 (high)** org-wide GitHub App token in `git push` argv → cross-tenant repo access.
- **C2 (high)** the **resident** runs the identical untrusted harness with fully unrestricted egress.
- **Systemic:** terminate Anthropic/GitHub auth at an out-of-task egress proxy (kills A1/A2/D1),
  own-SG deny-by-default job egress + IMDSv2 hop-limit 1 (C1/C2), deterministic secret scan on
  delivered artifacts (injection-proof), fence the spec as untrusted data in every prompt (B1).
- **Isolation observation:** the preview IAM policy conditions on `Service=` not `Customer=`; real
  fix is per-job STS-session-tagged creds.

### GATE C — before trusting unattended delivery quality (product correctness)
- **Sweep 1** — the guestbook incident is half-fixed. The 401 half is wide open (A1/A2: nothing adds
  delivered routes to `publicUrls`, and wiredSmoke treats 401 as pass); no DB is ever provisioned
  (D1); the SPA is never actually rendered before the customer visits (D2); the gate silently
  verifies *nothing* for common RTK shapes (B1/B2/B3).
- **Sweep 4** — merges are trusted on git's exit code (never built/tested before the next task
  builds on them); conflict-repair validated by marker-scan only can drop a branch's work and ship
  green; the M9 liveness sweep is blind to `task_arn IS NULL` (the exact stuck-forever case).
- **Systemic:** gate-on-merge (or merge-to-integration-branch then fast-forward on green);
  reset+clean `main` between serialized merges; an age/heartbeat liveness sweep; token-aware
  probing + `publicUrls` reconciliation + render + DB-dependency smoke in the delivery gate;
  fail-closed on empty/undiscoverable probe surface.

## Method

Each sweep: 6 finders (one per failure mode, reading the real code) → dedup across finders → every
surviving finding faced 2 perspective-diverse skeptics prompted to *refute* it (default false) →
synthesis. Sweeps were told each other's scope to minimize overlap. ~182 agents, ~10.2M tokens total.
Raw per-agent results under each run's `journal.jsonl` in the session's workflow transcript dir.
