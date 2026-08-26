-- 0009_resident_usage (M8 billing): resident installations' daily usage records, what the
-- factory knows about each installation (org, billing customer) and what has been reported
-- to the payment provider per month.
--
-- `resident_usage` keeps the whole `ResidentUsageRecord` as jsonb (the contract in
-- @mf/models) plus the columns the monthly aggregation groups and sums over. One row per
-- installation and UTC day; a day reported twice replaces the earlier row (last write wins).
-- `resident_installations` is created on the first record (unlinked) and completed by an
-- admin. `resident_usage_reports` holds the cumulative cents reported for a month, so a
-- billing run is idempotent and a later run only reports the difference.

create table resident_installations (
	id text primary key,
	org_id text,
	billing_customer_id text,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

create table resident_usage (
	installation_id text not null references resident_installations(id) on delete cascade,
	day date not null,
	month text not null,
	repository text not null,
	total_tokens bigint not null,
	list_price_usd double precision not null,
	billable_usd double precision not null,
	tasks_started integer not null,
	tasks_succeeded integer not null,
	tasks_failed integer not null,
	pull_requests_opened integer not null,
	record jsonb not null,
	generated_at timestamptz not null,
	received_at timestamptz not null default now(),
	primary key (installation_id, day)
);
create index resident_usage_month_idx on resident_usage(month, installation_id);

create table resident_usage_reports (
	installation_id text not null references resident_installations(id) on delete cascade,
	month text not null,
	usd_cents bigint not null default 0,
	provider text not null check (provider in ('stripe', 'fake')),
	reference text,
	-- Reserve-then-confirm: the cumulative cents + identifier handed to the provider, cleared
	-- once the report is confirmed (usd_cents := pending_usd_cents)
	pending_usd_cents bigint,
	pending_identifier text,
	pending_at timestamptz,
	reported_at timestamptz not null default now(),
	primary key (installation_id, month)
);
