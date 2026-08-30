-- 0006_orders_payments (M6): the order record (name, state machine) and Stripe payments.
--
-- `orders.status` is the order state machine (drafting → ready → frozen → deposit_paid →
-- building → delivered → paid | cancelled); the spec engine reads `drafting`/`ready` as-is
-- and everything else as `frozen`. `payments` holds one row per Checkout session (deposit /
-- balance); `payment_events` records every processed webhook event id so a redelivered event
-- is a no-op.

alter table orders add column name text not null default '';

create table payments (
	id uuid primary key default gen_random_uuid(),
	order_id text not null references orders(id) on delete cascade,
	kind text not null check (kind in ('deposit', 'balance')),
	status text not null default 'pending' check (status in ('pending', 'paid')),
	provider text not null check (provider in ('stripe', 'fake')),
	amount_sek integer not null,
	vat_sek integer not null,
	total_sek integer not null,
	session_id text not null unique,
	event_id text,
	hosted_invoice_url text,
	receipt_url text,
	paid_at timestamptz,
	created_at timestamptz not null default now()
);
create index payments_order_idx on payments(order_id, created_at desc);

-- One paid payment per order and kind (a second paid session of the same kind is flagged as a refund)
create unique index payments_one_paid_per_kind on payments(order_id, kind) where status = 'paid';

create table payment_events (
	id text primary key,
	type text not null,
	received_at timestamptz not null default now()
);
