-- 0001_init: core domain (PLAN.md) — orgs, users, orders, jobs, job_events

create extension if not exists "pgcrypto";

create table orgs (
	id uuid primary key default gen_random_uuid(),
	name text not null,
	org_number text,
	created_at timestamptz not null default now()
);

create table users (
	id uuid primary key default gen_random_uuid(),
	org_id uuid not null references orgs(id) on delete cascade,
	email text not null unique,
	name text,
	role text not null default 'user' check (role in ('admin', 'user')),
	created_at timestamptz not null default now()
);

create table orders (
	id uuid primary key default gen_random_uuid(),
	org_id uuid not null references orgs(id) on delete cascade,
	created_by uuid not null references users(id),
	status text not null default 'draft'
		check (status in ('draft', 'spec', 'frozen', 'deposit_paid', 'building', 'delivered', 'paid', 'cancelled')),
	spec jsonb,
	size_class text check (size_class in ('S', 'M', 'L')),
	price_sek integer,
	stripe_deposit_session_id text,
	stripe_balance_session_id text,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);
create index orders_org_idx on orders(org_id, created_at desc);

create table jobs (
	id uuid primary key default gen_random_uuid(),
	order_id uuid not null references orders(id) on delete cascade,
	status text not null default 'queued'
		check (status in ('queued', 'planning', 'building', 'verifying', 'delivered', 'failed', 'killed')),
	budget_tokens integer not null,
	tokens_used integer not null default 0,
	repository_url text,
	deploy_url text,
	deliverable_key text,
	started_at timestamptz,
	finished_at timestamptz,
	created_at timestamptz not null default now()
);
create index jobs_order_idx on jobs(order_id, created_at desc);

create table job_events (
	id bigserial primary key,
	job_id uuid not null references jobs(id) on delete cascade,
	type text not null,
	payload jsonb not null default '{}',
	created_at timestamptz not null default now()
);
create index job_events_job_idx on job_events(job_id, id);
