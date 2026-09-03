-- 0024_order_exports (wave 14, hosting window — strategy F4): the final export an order gets
-- before its hosting window ends and the scheduled teardown removes everything the delivery
-- provisioned (ECS Express service, preview database + role, preview storage prefix + role).
--
-- One row per order, and the row IS the idempotency lock: `finalExport` claims it with an
-- insert-or-reclaim compare-and-set (a `failed` row, or a `pending` one older than the stale
-- window, may be re-claimed; a `done` row is final and a fresh `pending` one is somebody else's
-- run in flight). `files` lists everything written under `key` (`deliverables/<jobId>/export/`):
-- `repo.zip`, `database.json`, `storage/*` + `storage-manifest.json`, and — appended when the
-- teardown completes — `DELETION-CERTIFICATE.md`. `orderExportStatus` in @mf/models mirrors the
-- CHECK; `enumDrift.test.ts` keeps the two in step.
--
-- `job_id` is the delivered job the bundle came from; null when the order never delivered (the
-- export then holds nothing but the certificate). Forward-only and data-free.

create table order_exports (
	order_id text primary key references orders(id) on delete cascade,
	job_id uuid references jobs(id) on delete set null,
	key text not null,
	status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
	files jsonb not null default '[]'::jsonb,
	error text,
	created_at timestamptz not null default now(),
	finished_at timestamptz
);
