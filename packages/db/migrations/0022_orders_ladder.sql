-- 0022_orders_ladder (wave 14, pricing ladder 2026-08-31): the shared "orders shape" the
-- ladder's flows build on — docs/backlog/strategy-2026-08-31.md.
--
-- `kind` is which rung of the ladder an order sits on: `build` (a real 3–5k kr build, every
-- order until now) or `demo` (the ~500 kr voucher demo build, "give us one of your problems").
-- Demo orders are capped per week and admin-approved before any tokens are spent, so
-- `build_approved_at` is the instant an admin approved a demo's build to start (null = not yet
-- approved); a real build never needs it. `orderKind` in @mf/models mirrors the CHECK and
-- `enumDrift.test.ts` keeps the two in step.
--
-- `hosting_until` is the end of the hosting window included in the order's price (a demo's
-- short showcase, a build's included months); null = no scheduled end. The future
-- scheduled-teardown sweep lists active orders whose window has passed, hence the partial index
-- — it stays tiny because most orders have no scheduled end at all.
--
-- Forward-only and data-free: every existing row is a `build` with no scheduled end, which the
-- defaults express without touching a row.

alter table orders
	add column kind text not null default 'build' check (kind in ('build', 'demo')),
	add column hosting_until timestamptz,
	add column build_approved_at timestamptz;

create index orders_hosting_until_idx
	on orders(hosting_until)
	where lifecycle = 'active' and hosting_until is not null;
