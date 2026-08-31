# Audit appendices — 31 August 2026

Working files behind [docs/CODE-AUDIT-2026-08-31.md](../CODE-AUDIT-2026-08-31.md). Read the main
audit first; come here for the location, snippet and reasoning behind a specific finding.

**Delete this folder once the P0/P1 list in the main audit is burned down.** It is a snapshot of
`main` at `8574129`, not a living document — line numbers drift.

| File | Stream | Finding IDs |
| ---- | ------ | ----------- |
| [ORCHESTRATOR.md](ORCHESTRATOR.md) | `packages/harness` + `apps/job`: plan → DAG → workers → merge → gates → delivery | `ORC-01`…`ORC-24` |
| [INFRA.md](INFRA.md) | CDK stacks, GitHub Actions, Dockerfiles, egress proxy, deploy scripts | `INF-01`…`INF-31` |
| [BACKEND.md](BACKEND.md) | `apps/api`, `packages/db`, `packages/models` — correctness and data layer | `API-01`…`API-23` |
| [FRONTEND.md](FRONTEND.md) | `apps/portal`, `apps/site`, template drift, i18n, a11y | `FE-01`…`FE-25` |
| [DOCS.md](DOCS.md) | PLAN/README/backlog coherence, milestone-claim accuracy, repo hygiene | `DOC-01`…`DOC-10` |

Each report was produced against the source and re-checked; every P0 in the main audit was
additionally verified by hand against the file it cites. Findings not promoted to P0/P1 have not
all been independently re-verified — confirm before acting on a P2.
