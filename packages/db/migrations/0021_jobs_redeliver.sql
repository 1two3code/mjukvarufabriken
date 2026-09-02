-- 0021_jobs_redeliver: a job can now RE-DELIVER an earlier job's repository instead of building.
--
-- Dogfood run 7 (2026-09-02, docs/LEARNINGS.md) passed every gate and delivered its repository,
-- then lost the deploy to an IAM defect. The only retry available was a full rebuild from the
-- spec (~USD 17 of worker tokens) for a failure that lived entirely on the hosting side. A
-- `redeliver` job clones the delivered repository and runs just the delivery half — docs, deploy,
-- live acceptance, bundle — for near-zero tokens. `source_job_id` is the job whose repository is
-- delivered again; its Express service, database and storage role are reused, not duplicated.
--
-- Forward-only and data-free: every existing row is a `build`.
alter table jobs add column mode text not null default 'build'
	check (mode in ('build', 'redeliver'));
alter table jobs add column source_job_id uuid references jobs (id);
