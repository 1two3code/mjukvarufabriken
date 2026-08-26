-- 0005_jobs_gates: M4 QA gate reports + admin waivers on the job row
-- jobs.gates: GateReport[] (name, ok, startedAt, durationMs, tokens, summary, details), in run order
-- jobs.gate_waivers: review finding ids ("<file>:<line>") an admin has waived for this job

alter table jobs add column gates jsonb;
alter table jobs add column gate_waivers jsonb not null default '[]';
