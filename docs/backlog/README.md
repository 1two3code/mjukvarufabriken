# Overnight backlog (2026-08-26 → 27)

Hasse asked for the rest of PLAN.md to be worked overnight, in parallel where efficient. Each stream
below is a self-contained brief; agents work on a branch `wave<N>/<stream>` in their own git
worktree and never touch `templates/web`, `.env`, or deploy. Integration (merge to `main`, full
verify, dev deploy) happens between waves in the main session.

Rules for every stream (in addition to CLAUDE.md, templates/web/CLAUDE.md, `.claude/rules/`):

- Work ONLY inside the stream's areas listed in its brief; anything else is out of scope (note it
  in the report instead). This is what makes the streams mergeable.
- `npm run lint`, `npm test`, `npm run build` must be green in the worktree before you finish;
  infra streams also `cd infra && npx cdk synth`. Add tests for new behaviour, mirroring the
  existing test style in that workspace.
- Commit on your branch in conventional commits. Do not merge, rebase, push or deploy.
- Anything that needs someone else's approval (accounts, keys, quotas) → add a row to
  TODO-EXTERNAL.md and build against an env var / fake so the code is still testable.
- Tick PLAN.md boxes only for what is verified; otherwise leave the box and add a dated note.
- Return a short report: what was built, verification numbers, what is not done and why.

| Wave | Stream | Brief | Areas |
|---|---|---|---|
| 1 | persistence | [persistence.md](persistence.md) | packages/db, apps/api (store/services/plugins for specs, orders, users, auth) |
| 1 | m4-gates | [m4-gates.md](m4-gates.md) | packages/harness, packages/models (job/gate schemas), apps/job |
| 1 | m7-site | [m7-site.md](m7-site.md) | apps/site, apps/api `routes/bff/contact` only |
| 1 | m9-ops | [m9-ops.md](m9-ops.md) | infra, .github, docs/RUNBOOK.md |
| 2 | m5-delivery | [m5-delivery.md](m5-delivery.md) | packages/harness (delivery step), apps/api (deliverables), infra (App Runner/IAM) |
| 2 | m6-orders | [m6-orders.md](m6-orders.md) | apps/api (orders, Stripe), apps/portal (order flow, job page, admin) |
| 2 | m3-hardening | [m3-hardening.md](m3-hardening.md) | apps/job, apps/api (job reporting endpoint), infra |
| 3 | m8-resident | [m8-resident.md](m8-resident.md) | packages/resident (new), infra templates |
| 3 | efficiency | [efficiency.md](efficiency.md) | packages/harness (worker loop), measured with fakes only |
