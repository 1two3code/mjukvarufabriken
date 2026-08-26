-- 0008_job_events_seq (M3 hardening review): the build container numbers every event it sends
-- (`seq`, 1-based per job) so a batch replayed after a lost response (ALB 502/504, api task
-- rolling) is stored once — the api inserts with `on conflict (job_id, seq) do nothing` and
-- skips the side effects (admin mail, jobs.gates) of a duplicate. Api-written events
-- (`kill`, RunTask failures) carry no seq.

alter table job_events add column seq integer;
create unique index job_events_job_seq_idx on job_events(job_id, seq) where seq is not null;
