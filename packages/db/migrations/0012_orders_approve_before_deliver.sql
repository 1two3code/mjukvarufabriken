-- 0012_orders_approve_before_deliver (W7): the approve-before-deliver gate.
--
-- Per-order flag for the human-in-the-loop delivery gate. When true, a build whose job has
-- delivered parks the order in `awaiting_approval` (a new order state) instead of going straight
-- to `delivered`; an admin/customer then approves (`awaiting_approval → delivered`) after seeing
-- the gate reports and preview. Default false keeps the existing auto-deliver flow unchanged.

alter table orders add column approve_before_deliver boolean not null default false;
