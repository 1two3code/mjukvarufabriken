# Stream: product-polish — portal job/order views + site copy

Areas: `apps/portal` (all), `apps/site` (copy/components only). Do NOT touch api/harness/job/infra
(read the api response shapes from `packages/models` and the existing route files; do not change
them).

## Context
The portal has order/spec/job pages and an admin view (waves 2/5). Gaps noted in the wave-5 reports:
the job page should show the five gate reports (from `jobs.gates` / the job event `gate` payloads)
with a per-gate expandable summary; deliverables (repo url, deploy url, bundle download links from
`GET /bff/jobs/:id/deliverables`) with the transfer-pending hint; and the licence gate's portal
locale key exists (`job.gates.name.licence`) — confirm every gate name has sv+en labels. The public
site (wave 1/m7) has placeholder copy.

## Deliverables
1. Job page: a gate-report section — one row per gate (name label sv/en, ok/failed, duration,
   tokens, one-line summary) with an expand for details (review findings count, acceptance
   report criterion→status, licence counts). Redacted fields (admin-only) already come filtered from
   the api — render what's present, hide what's absent. Deliverables section: repo/deploy links +
   download links when present, transfer-pending hint otherwise.
2. Order page: the stepper reflects the real order status; show payments (deposit/balance status,
   hosted invoice link) when present; link to the job page.
3. Every gate name and job/delivery status has an sv + en locale key (audit `public/locales/{sv,en}.json`).
4. Site: replace placeholder landing/how-it-works/pricing copy with real, honest copy consistent
   with PLAN.md (the six-step flow, S/M/L 15k/45k/120k SEK, what's included/not, the "built by
   sandboxed AI agents under hard budgets + QA gates, fails closed" framing). No fake testimonials
   or invented numbers. Keep the DRAFT banner on the legal pages.
5. Extend `scripts/smoke-spa.mjs` to visit the new/updated routes with a fake session and fail on
   console errors (the portal has a test setup since wave 5, but keep to the smoke approach here).

## Verify
`npm run lint`, `npm test`, `npm run build`, `npm run smoke`. Commit in conventional commits.
No deploy.
