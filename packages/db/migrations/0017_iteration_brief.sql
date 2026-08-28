-- 0017_iteration_brief (wave 10, resident-journal-foundation): the resident LLM's structured
-- iteration brief per customer org and project (docs/backlog/environments.md, M11). As the
-- resident works with the customer in the live dev loop it captures the questions that go BEYOND
-- frontend — data model, integrations, auth, business rules, infra, scale — and their answers,
-- decisions and context. The brief accumulates across iterations and is exported as the seed for
-- the next full factory build (the @mf/harness spec engine consumes a SpecDraft-shaped input).
--
-- One row per (org, project). `entries` is the ordered `IterationBriefEntry[]` (the contract in
-- @mf/models) as jsonb; entries are appended (append-only in practice). `project_id` is the
-- delivered app / order id, but not a foreign key — a project the resident tracks may not have an
-- orders row, and the table stays decoupled from the order lifecycle. This is the DATA foundation
-- only; the live resident-LLM wiring is later M11.

create table iteration_brief (
	org_id text not null,
	project_id text not null,
	title text,
	entries jsonb not null default '[]'::jsonb,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	primary key (org_id, project_id)
);

-- List a whole org's briefs newest-first without scanning the table
create index iteration_brief_org_idx on iteration_brief (org_id, updated_at desc);
