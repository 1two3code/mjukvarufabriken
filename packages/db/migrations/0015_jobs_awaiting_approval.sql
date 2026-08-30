-- 0013_jobs_awaiting_approval (W9): the pre-delivery approval hold becomes real.
--
-- Wave 8 (0012) added the ORDER-level `approve_before_deliver` flag, but the gate was only a
-- post-delivery order label: the build's job had already delivered (repo pushed / gone live).
-- W9 makes it an ACTUAL hold in the harness — after the green gates a job whose order has the
-- flag pauses BEFORE delivery. Two job-level booleans back that pause:
--   * `awaiting_approval` — set true by the build container when it reaches the hold; the api
--     exposes it so a human sees a job parked before delivery (distinct from the order label).
--   * `approved`          — the resume signal, flipped by the approve action; the paused job
--     polls its report view for it and, once true, proceeds into delivery.
-- Both default false, so a job whose order leaves the flag off auto-delivers exactly as before.

alter table jobs add column awaiting_approval boolean not null default false;
alter table jobs add column approved boolean not null default false;
