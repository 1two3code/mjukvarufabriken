# Build brief: dev-env live edits → escalate to a full mjukvaruhuset build

> **STATUS 2026-08-30: DESIGN DRAFT, NOT STARTED.** Written at Hasse's request as the detailed
> follow-through on the one-liner already in [environments.md](environments.md) ("the resident
> delivers that brief back to mjukvaruhuset as the input to the next full factory iteration"). Do
> not build against this until the open decisions at the bottom are answered — several of them
> (who can trigger it, how it's billed) are business calls, not engineering ones.

This is M11's phase-2/3 mechanism in detail: the customer's `dev` environment (always-on, live-edit
LLM, mjukvaruhuset-paid) is where day-to-day requests land. Most are small enough for the live-edit
agent to just do. Some aren't — this brief is the path from "the frontend agent can't do this alone"
to "a real harness job builds it," and back into the same environment when it's done.

## The two paths

**Path A — the frontend agent just does it.** Copy, styling, layout, small client-side logic — the
live-edit agent applies the change directly to the running `dev` server (HMR), no escalation, no new
charge (covered by whatever's already been sold — a demo top-up, a subscription, or bundled with the
current order, depending on where the pricing rethink lands). This is what M11 already describes.

**Path B — escalate to a full build.** The request needs something the frontend agent's scope
doesn't cover: a new data model, a backend endpoint, an integration, auth/roles, a business rule. The
agent can't do this itself (see "the scope boundary" below) — it drafts what the request implies into
the customer's **iteration brief** (already scaffolded: `IterationBrief` model, migration 0017,
`toIterationBriefSpecSeed` — built in wave 10, currently unused by anything live) and surfaces a
**"Send to mjukvaruhuset"** action. The customer (or whoever has permission — open question) presses
it; that's what this brief is actually about.

## The scope boundary (how the agent knows which path it's on)

Ties directly to M11's still-open question ("what stops the aesthetic-changes LLM from touching
business logic"). Proposed: the boundary **is** the frontend agent's toolset/path allowlist, not a
judgment call it makes each time — e.g. scoped to `apps/site|portal/src` styles/copy/markup/simple
client state, no `apps/api`, no `packages/db` migrations, no `infra`, no auth code. A request that
needs a write outside the allowlist is mechanically refused, and *that refusal* is the signal to draft
an iteration-brief entry and offer the button — not a separate "is this a big request?" classifier the
agent could get wrong. Reuses the same cap/pause/audit machinery as M8 resident (already RESOLVED in
M11) either way — this section is about *scope*, that one's about *blast radius and spend*.

## What "Send to mjukvaruhuset" actually does

1. **Package the spec.** The iteration brief (open questions + decisions + context, accumulated
   across however many dev-session conversations) plus the dev server's current diff from what was
   last delivered/promoted becomes the input to the M2 spec flow — via `toIterationBriefSpecSeed`,
   already built.
2. **Clarification loop, reused from M2.** The packaged spec runs through the same
   `isSpecComplete` deterministic check the initial spec-chat uses. If it's not complete (most
   backend/data-model requests won't be, from a frontend chat alone), the loop asks the missing
   questions — where this conversation happens (the dev chat surface itself, or a handoff to the
   portal's existing spec-chat UI) is an open question.
3. **A real harness job — but a new mode.** M3's harness plans/builds against a **fresh** repo
   seeded from `templates/web`. This is different: it needs to plan and build against the
   **customer's own existing, already-delivered repo** (specifically, the current state of their
   `dev` environment, which may include live edits never yet promoted to qa/live). Needs:
   - Clone the customer's current repo as the base instead of `templates/web`.
   - Planner context is the existing codebase, not a blank slate — bigger context, different
     planning shape than a from-scratch build.
   - Gates (M4) still apply, but "does this look like a working new app" acceptance criteria need
     to become "does this specific change work, without breaking what was already there."
   - This is real new work in `@mf/harness` — not a config flag on the existing planner/DAG/worker
     code, a genuinely different entry point that happens to reuse the worker/gate machinery.
4. **Approval/payment gate before it runs.** Same caution as the M10 standing reminder — this is a
   real paid Fargate run and should not fire on a press-of-a-button with no spend control. Exact
   shape depends on the still-unresolved pricing rethink: is pressing the button itself the
   $300–500 upsell moment (one-off charge, Stripe checkout inline), or is it metered against an
   existing LLM-edits subscription? Either way, some confirmation step belongs here, not an
   unconditional auto-run.
5. **Where the result lands.** Proposed: back into the *same* `dev` environment (updates the live
   dev server), not straight to a qa candidate — so the customer/agent can look at the bigger change
   live before it goes through the same portal dev→qa→live promotion every other change uses. Keeps
   promotion uniform regardless of whether a change originated as a live edit or a full build.

## Open decisions (Hasse's calls — do not build against assumptions here)

- **Who can press the button?** Fully self-service by the customer, or does it need mjukvaruhuset
  staff review first (spend control, quality control) before a real job runs? A hybrid — self-service
  under some cap, review above it — is also plausible.
- **Billing.** Depends entirely on where the pricing rethink (PLAN.md Decisions, "under revision")
  lands — one-off upsell charge vs. subscription-metered vs. something else. This brief assumes
  *some* payment/authorization step exists here but doesn't guess which.
- **Where does the clarification conversation happen** — inline in the dev-env chat, or handed off
  to the existing portal spec-chat surface?
- **Concurrency.** If the customer keeps live-editing `dev` while a big harness job is building
  against a clone of it, whose changes win when the job finishes? Needs a real answer (lock dev
  during the build? diff and flag a conflict? last-write-wins with a warning?) before this ships.
- **Failure handling.** If the escalated job's gates fail (or the budget aborts it), does `dev` stay
  exactly as it was, and is the customer charged anyway? Precedent: the existing budget-abort/refund
  handling in payment/order flow, but this is a new trigger point for it.

## Where this lands in the plan

Sits inside `PLAN.md` **M11 — Environments**, specifically phase 3 (qa/live) in
[environments.md](environments.md)'s phasing, though the escalation mechanism itself (packaging,
clarification, the new harness build-against-existing-repo mode) is really its own chunk of work
independent of qa/live promotion — could be built and dogfooded against `dev` alone before qa/live
exists. Depends on: the M11 scope-boundary/toolset design (not built), the `IterationBrief`
foundation (built, wave 10, unused), M2's `isSpecComplete` (built, reusable as-is), and the pricing
rethink landing somewhere concrete enough to build the payment step against.
