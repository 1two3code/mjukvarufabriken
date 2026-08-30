# Multi-environment platform + per-customer environments (dev / qa / live)

> **STATUS 2026-08-29:** phase 1 (platform `qa` env) is BUILT (ultracode wave 9/10). Customer-side foundations landed too: order lifecycle `active|suspended|torn_down`, the resident **iteration-brief** foundation (model + db 0017 + api + `toIterationBriefSpecSeed`). Still needs the M11 design decisions below + the live resident-LLM + per-customer dev/qa/live delivery.

Direction set by Hasse 2026-08-28. This is the shift from "the factory delivers a one-shot
artifact" to "the factory delivers and operates a living product with a resident LLM." It
subsumes and evolves M8 (resident agent).

## The vision

**1. mjukvaruhuset's own platform gets three environments: dev → qa → live.**
Today `infra/lib/config.ts` has `dev` + `live`. Add `qa` (staging that mirrors live) so we ship
our own changes through dev → qa → live like everyone else.

**2. Every delivered customer app comes with its own environments, mirroring ours.**
Delivery stops producing a single preview URL and instead stands up the customer's environments.
Phased: first **qa + live**, then full **dev / qa / live**.

- **dev** — the customer's living workspace: a *hosted, live-updating dev server* they connect to,
  with a **resident LLM wired into that running server**. The customer chats with the LLM; it makes
  changes (aesthetic first, then broader), the running app updates live (hot reload), they see it
  immediately. The customer may simply call this "dev" and spend most of their time here.
  - **Resident LLM as a requirements journal (Hasse 2026-08-28).** The resident does more than
    live frontend tweaks: as it works with the customer it **notices and asks the questions that go
    beyond "just frontend"** — data model, backend/API, integrations, auth/roles, business rules,
    infra, scale, edge cases — and **writes down the answers**. It maintains a structured
    *iteration brief* (open questions + decisions + context) for this specific customer/project, and
    **delivers that brief back to mjukvaruhuset as the input to the next full factory iteration**.
    This bridges the two loops: the fast in-dev live-edit loop and the next one-shot(ish) factory
    build. It also turns the customer's ad-hoc requests into captured requirements the factory can
    build against — so v0.1 → v0.2 is a real spec, not a re-guess. Ties to the spec engine
    (`@mf/harness` planner) consuming the brief, and to per-customer project memory.
- **qa** — a release-candidate mirror of live. Changes promoted from dev land here; the QA gates
  (M4) run against it before it can go to live. "qa and live are the same most of the time."
- **live** — production, the URL the customer's users hit. Promotion is dev → qa → live.

So the product loop becomes: **build once (factory) → iterate forever in dev with the resident LLM
→ promote qa → promote live.** The recurring-revenue engine, not the one-shot build.

**Evidence (2026-08-28):** the first real delivery — family-hub #2 (`mjukvaruhuset/family-hub`,
live at the dev Express URL) — is a working **v0.1, not a finished product**: it needs many more
iterations before it's anywhere close to done (Hasse's words). That is exactly the case for this
milestone: the one-shot factory produces a correct *starting point*; the value — and the recurring
revenue — is the **iterate-forever loop** (hosted dev + resident LLM) that takes v0.1 → shippable.
The one-shot build is the on-ramp, not the destination.

## How it builds on what exists
- The **ECS Express service** the delivery now creates is the first environment (the customer's
  live/qa). Standing up three is "the same, three times, with promotion between them."
- The **resident agent** (`packages/resident`, `infra/resident`) is exactly the "LLM wired into the
  dev server" — but it must evolve from *issues → build → PR* into *chat → live edit on a running
  dev server → promote*. The live-editing loop is a resident worker operating on a running Vite dev
  server (edit source → HMR) rather than a full rebuild each time.
- The **harness worker/gate code** is reused for promotion (qa gates before live).

## Phasing (proposed — confirm before building)
1. **Platform qa** (small, concrete): add `qa` to our config — domains `qa.mjukvaruhuset.se` /
   `api.qa…` / `portal.qa…`, stacks `resources-qa` / `mf-qa` / `ops-qa` / `budget-qa`, deploy
   pipeline dev → qa → live. Purely our infra.
2. **Customer live + qa from delivery**: delivery stands up two Express services (qa, live) instead
   of one, wires a promote (qa → live) action into the portal, runs the gates against qa on promote.
3. **Customer dev + resident LLM**: a per-customer hosted dev server (live-updating) + the resident
   LLM connected to it, with a chat surface (portal or the customer's own). Live aesthetic edits →
   HMR; "promote to qa" packages the change and runs it through qa → live.
4. **Metering/billing** for the always-on dev env + resident LLM (resident mode = tokens × 1.5 +
   monthly fee is already decided) — per-environment cost visibility.

## Open decisions to lock (Hasse's calls)
- **Whose account? — RESOLVED 2026-08-28:** an AWS **Organization** vends one member account per
  customer; we operate it (assume-role), the customer can graduate by moving the account out. The
  three envs (dev/qa/live) are separate stacks inside that one account for v1. See the Decisions
  section of PLAN.md and the build brief [org-accounts.md](org-accounts.md).
- **Cost model for always-on dev + qa per customer.** Three ECS services (shared ALB helps) + a
  resident LLM per customer is real monthly cost. Need a per-customer pricing/cap tied to the
  resident monthly fee. Scale-to-zero for idle dev/qa?
- **"Live update" mechanism.** A running Vite dev server with HMR that the LLM edits (fast, feels
  live, but a dev server isn't production-grade) vs. rebuild-and-redeploy each change (slower,
  production-parity). Likely: HMR dev server for the *dev* env, real build/deploy for qa/live.
- **Promotion model.** Git branches per env (dev/qa/live) + PRs, or image promotion (build once,
  deploy the same image to qa then live)? Image promotion is cleaner for parity.
- **Who is the resident LLM's identity/keys?** Resident v1 = customer's own Anthropic key. Same here?

## Where this lands in the plan
`PLAN.md` **M11 — Environments (dev/qa/live)** is the canonical milestone (added by a parallel
session 2026-08-28); this file is the working design scratchpad it links to. M11 supersedes/absorbs
M8's scope — M8's `packages/resident` becomes the foundation. M7/M10 unaffected. The current M5
delivery (single Express service) is the seed of the customer qa+live iteration.

Note: keep the two in sync — the open decisions here (whose AWS account, cost model, live-update
mechanism, promotion model, LLM identity) are the same questions M11's checklist raises; resolve
them once, in M11, before any building starts.
