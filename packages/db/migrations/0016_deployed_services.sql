-- 0016_deployed_services (wave 10, delivery-lifecycle-followups): track every ECS Express service
-- a delivery stands up, PER ORDER (docs/backlog/teardown-deprovisioning.md). Closes two lifecycle
-- gaps wave 9 flagged:
--   (a) a rebuilt order mints a NEW job-unique `Customer=<slug>` fence per build, so tag-based
--       discovery only ever finds the newest delivery's service and orphans the earlier ones. The
--       admin teardown / @mf/org deprovision reads this table to target EVERY recorded service.
--   (b) ECS Express has no scale-to-zero: a suspend DELETES the service. `resume` re-stands it up
--       by replaying the recorded `image` + `config` (the CreateExpressGatewayService input), so
--       the same image/roles/port/env come back rather than a fresh redelivery being owed.
--
-- The api records a row when a job reports a `deployUrl` (the final `delivery` bundle event carries
-- the service report). `config` keeps the exact create input so resume is a faithful replay; it
-- holds the container env (generated JWT/VAPID secrets), so it is never returned to a customer.

create table deployed_services (
	id uuid primary key default gen_random_uuid(),
	order_id text not null references orders(id) on delete cascade,
	job_id uuid references jobs(id) on delete set null,
	service_name text not null,
	-- Null after a suspend deletes the service (compute gone; the record + config are retained)
	service_arn text,
	-- The `Customer=<slug>` fence @mf/org deprovision scopes a real suspend/teardown to
	customer_tag text not null,
	image text,
	-- The CreateExpressGatewayService input `resume` replays to re-create the deleted service
	config jsonb,
	created_at timestamptz not null default now(),
	-- Set when a teardown permanently removed the service (soft-deleted record, kept for audit)
	deleted_at timestamptz
);

-- The lifecycle action lists a single order's live (not torn-down) services; a partial index keeps
-- that read cheap and lets a redelivery of the same service_name upsert onto the live row.
create unique index deployed_services_order_service_idx
	on deployed_services(order_id, service_name)
	where deleted_at is null;
create index deployed_services_order_idx on deployed_services(order_id, created_at desc);
