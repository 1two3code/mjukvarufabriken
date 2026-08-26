-- 0002_jobs_task_arn (M3): make the jobs row self-contained for the build container and the
-- kill switch. Orders still live in the api's in-memory store until M6, so the job carries a
-- copy of the frozen spec + the org id, and `order_id` becomes a plain text id (e.g. "demo").

alter table jobs drop constraint jobs_order_id_fkey;
alter table jobs alter column order_id type text using order_id::text;

alter table jobs
	add column org_id text not null default '',
	add column spec jsonb not null default '{}',
	add column plan jsonb,
	add column reason text,
	add column task_arn text,
	add column max_workers integer not null default 2,
	add column max_duration_minutes integer not null default 120,
	add column updated_at timestamptz not null default now();

create index jobs_org_idx on jobs(org_id, created_at desc);
