-- 0007_jobs_report_token (M3 hardening, docs/M3-REVIEW.md #18): the build container reports
-- through the api instead of holding the RDS secret. The api mints a random 32-byte token per
-- job at start, stores only its sha256 here and passes the token to the task in the RunTask
-- container override. `/internal/jobs/:id` authenticates by (id, hash) — nothing else.

alter table jobs add column report_token_hash text;
create index jobs_report_token_hash_idx on jobs(report_token_hash) where report_token_hash is not null;
