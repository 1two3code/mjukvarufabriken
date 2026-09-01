-- 0020_orders_status_awaiting_approval (wave 13, audit P0-2): `orders_status_check` still carried
-- the eight statuses 0004 re-added it with, but `orderStatus` in @mf/models grew a ninth,
-- `awaiting_approval`, when the order-approval step (W7, `orders.approve_before_deliver`) landed
-- in 0012. Nothing re-stated the CHECK, so the enum in code and the constraint in the schema drifted.
--
-- The consequence was not theoretical: with the flag on, `orderService.syncWithJob` transitions a
-- delivered build's order to `awaiting_approval`, which Postgres rejected with 23514 — and since
-- that sync runs inside `getDetail`, the order's detail endpoint then 500'd on every subsequent
-- read, for customer and admin alike, at exactly the handover moment.
--
-- Forward-only and data-free: no existing row can hold `awaiting_approval` (the constraint made it
-- unwritable), so re-stating the CHECK with the full nine-value list is the whole fix.
-- `enumDrift.test.ts` now derives the expected list from @mf/models and fails if the two ever part
-- ways again — for this constraint and for `jobs.status` and `orders.lifecycle`.

alter table orders drop constraint orders_status_check;
alter table orders add constraint orders_status_check check (
	status in (
		'drafting', 'ready', 'frozen',
		'deposit_paid', 'building', 'awaiting_approval', 'delivered', 'paid', 'cancelled'
	)
);
