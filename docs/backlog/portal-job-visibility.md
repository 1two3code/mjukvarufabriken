# Backlog brief: the portal's job view is too coarse, and the portal needs to scroll

Captured 2026-09-03 from Hasse. Two separate items that both live in `apps/portal`; the first
also needs a little api/harness plumbing. Neither is scheduled.

## 1. The job page (and the admin job page) do not show what the harness is actually doing

Hasse's observation, verbatim: another session reported *"All tasks merged (one small repair on
camera-capture, 41k tokens) and verify is green. Acceptance-tests, review, licence and
acceptance-check next, then delivery."* — none of that reads off the job page. The session got it
from the raw event stream and the logs; a customer (or Hasse on `/admin/jobs`) gets a flat event
log plus, since wave 14 (PR #122), a delivery-step timeline and a job list. What is missing is the
**build half** of the job as a structured, current-state view.

### What the data already carries (nothing new needs to be emitted for most of this)

`jobs.events` (`GET /bff/jobs/:id/events`, `jobEventType` in `packages/models/schemas/Job.ts`):
`started`, `planned` (the task DAG), `task_started` / `task_finished` / `task_failed` (per task,
with tokens and turns), `merge` (per task, incl. repair outcome and tokens), `verify`, `gate`
(one per gate with `ok` + summary + details), `delivery` (per step), `retry`, `notify`, `done`,
`failed`, `killed`, `log`. `JobEventLog.tsx` renders every type as one line each and nothing
groups or summarises them. The plan (`planned` payload) names every task and its dependencies;
the gate order is fixed in the harness (verify → acceptance-tests → review → licence →
acceptance-check → delivery); both are known before they happen.

### What to build

- **A phase strip at the top of the job page**: plan → build (tasks) → merge → verify →
  acceptance-tests → review → licence → acceptance-check → delivery → done, each phase
  `pending | running | ok | failed | skipped`, derived client-side from the events (the harness
  order is a constant the portal can own; the gates that a job has not reached yet show as
  pending, which answers "what's next"). The current phase carries its elapsed time.
- **A task board under it**, from the `planned` payload: one row per task with status, tokens,
  turns, cap-hit, and its merge outcome (clean / repaired with N tokens / failed), plus the DAG
  edges as "after: …". This is where "one small repair on camera-capture, 41k tokens" belongs.
- **Gate cards** reuse `GateReports.tsx` but appear in order with the pending ones greyed, so
  the sequence is visible before the reports exist.
- **The admin jobs table** gets the current phase as a column (replacing or next to `status`,
  which only says `building`/`verifying` today) and the tokens-per-phase split on hover; the
  overview totals could show "jobs by phase".
- **Live**: the existing 3 s events poll (`getJobEvents` `after=`) already drives this; no new
  transport.

### Plumbing gaps (small)

- The per-task token/turn numbers are on `task_finished`/`merge` payloads; check
  `redactEventsForCustomer` keeps them (they are not secrets — the customer pays for them).
- `verify` today is one event; if the phase strip wants "verify started", emit a
  `verify` with `phase: 'started'` or derive "running" from "last merge finished, no verify yet".
- The harness `gate` order should be exported from `@mf/models` (a `gateOrder` const) so the
  portal and the harness cannot drift; `packages/harness/src/job/gates` is the source today.

### Tests

Portal: a pure `phasesOf(events)` helper with unit tests over recorded event fixtures (the
offline e2e in `packages/harness/test/job/e2e.offline.test.ts` produces a realistic stream that
can be saved as a fixture). Locale parity for every new phase label (sv + en).

## 2. The portal's `<main>` must scroll on the y axis

Hasse: the pages are "starting to get crowded". Today `#root` is a `height: 100dvh` grid
(`apps/portal/src/assets/styles/global.css`) and `ProtectedLayout.module.css` sets
`overflow: hidden` on the container, so a page taller than the viewport is clipped, not scrolled
— the order page (stepper + facts + approval + delivery outcome + payments + hosting panel +
gates + deliverables since wave 14) and the job page (job list + timeline + gate reports + event
log) both exceed one screen now.

### What to build

- Keep the header fixed, make `<main>` the scroll container: `overflow-y: auto; min-height: 0`
  on the grid child (the `1fr` row) — the `overflow: hidden` on the container was there to
  stop the horizontal scroll from wide tables; keep `overflow-x: hidden` on the container and let
  wide tables scroll inside their own `.tablewrap` (`overflow-x: auto`).
- Same for the template SPA (`templates/web/apps/app`): the built-by footer (wave 14, S4) sits
  under a `100dvh` root — delivered apps inherit the same clipping; fix in the template so every
  future build gets it (coordinate with the session working on Ögonblick — it edits the
  template's app shell).
- Smoke: `scripts/smoke-spa.mjs` can assert `document.scrollingElement`/`main.scrollHeight >
  clientHeight` renders without clipping on the order page fixture — optional; the CSS rule is
  the real fix.

Related: [next-2026-09.md](next-2026-09.md) (wave 14 delivery-outcome stream, which added most
of the panels that made the pages crowded), [wave6-product-polish.md](wave6-product-polish.md).
