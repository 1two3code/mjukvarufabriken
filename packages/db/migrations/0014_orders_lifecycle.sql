-- 0014_orders_lifecycle (wave 9, org-onboarding-lifecycle): the deprovisioning lifecycle of an
-- order's delivery (docs/backlog/teardown-deprovisioning.md #2). Every order starts `active`; an
-- admin action or the grace-period sweep moves it to `suspended` (reversible cost-stop — compute
-- torn down, storage retained) and then `torn_down` (permanent). `lifecycle_changed_at` is the
-- instant the grace-period sweep counts N days from when promoting suspended → torn_down.
--
-- `customer_slug` is the per-customer fence tag value (`Customer=<slug>`) delivery stamps on the
-- ECS Express service and everything it provisions; @mf/org `deprovision` scopes a real
-- suspend/teardown to exactly this slug, so a destructive run can never span orders. It is written
-- when the build starts (the same app-name/job derivation delivery uses) and read by the admin
-- lifecycle action; null before a build has ever run.

alter table orders
	add column lifecycle text not null default 'active'
		check (lifecycle in ('active', 'suspended', 'torn_down')),
	add column lifecycle_changed_at timestamptz,
	add column customer_slug text;

-- The grace-period sweep lists suspended orders oldest-change first; a partial index keeps it cheap.
create index orders_lifecycle_suspended_idx
	on orders(lifecycle_changed_at)
	where lifecycle = 'suspended';
