-- 0010_rate_limits (wave 4, api-hygiene): the contact-form rate limiter used to live in the api
-- process memory, so every task behind the ALB kept its own counters and a restart forgot them.
-- One row per counted hit, keyed by scope (`contact`) and key (client ip); the per-key and the
-- global ceiling are both counts over the window. Rows older than the retention are pruned by the
-- api's hourly housekeeping (the `pruner` plugin calls `rateLimits.pruneExpired()`).

create table rate_limits (
	id bigserial primary key,
	scope text not null,
	key text not null,
	hit_at timestamptz not null default now()
);
create index rate_limits_scope_key_idx on rate_limits(scope, key, hit_at desc);
create index rate_limits_scope_idx on rate_limits(scope, hit_at desc);
