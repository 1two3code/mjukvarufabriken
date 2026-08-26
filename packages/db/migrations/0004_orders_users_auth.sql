-- 0004_orders_users_auth (persistence stream): move what the api kept in its in-memory `store`
-- into Postgres. `orders` now carries the whole `SpecDraft` (status, spec, messages, open
-- questions, price, frozen_at); `magic_links` and `refresh_tokens` back the magic-link auth.
--
-- Order ids are client-chosen strings (the portal's `/orders/demo/spec`, uuids later), so the
-- primary key becomes text like `jobs.order_id` did in 0002. The org/user foreign keys are
-- dropped for the same reason as on `jobs`: the draft is scoped by the session's org id, and
-- an admin session's org does not have to be a customer org.

alter table orders drop constraint orders_status_check;
alter table orders drop constraint orders_org_id_fkey;
alter table orders drop constraint orders_created_by_fkey;

alter table orders alter column id drop default;
alter table orders alter column id type text using id::text;
alter table orders alter column org_id type text using org_id::text;
alter table orders alter column created_by type text using created_by::text;
alter table orders alter column created_by drop not null;

alter table orders alter column status set default 'drafting';
alter table orders add constraint orders_status_check check (
	status in (
		'drafting', 'ready', 'frozen',
		'deposit_paid', 'building', 'delivered', 'paid', 'cancelled'
	)
);

alter table orders
	alter column spec set default '{}',
	alter column spec set not null,
	add column messages jsonb not null default '[]',
	add column open_questions jsonb not null default '[]',
	add column frozen_at timestamptz;

-- Single-use sign-in links, keyed by the sha256 of the token (the token itself is only emailed)
create table magic_links (
	token_hash text primary key,
	email text not null,
	expires_at timestamptz not null,
	used_at timestamptz,
	created_at timestamptz not null default now()
);
create index magic_links_email_idx on magic_links(email, created_at desc);

-- Opaque refresh tokens, keyed by sha256; rotated on every refresh (revoked_at set)
create table refresh_tokens (
	token_hash text primary key,
	user_id uuid not null references users(id) on delete cascade,
	expires_at timestamptz not null,
	revoked_at timestamptz,
	created_at timestamptz not null default now()
);
create index refresh_tokens_user_idx on refresh_tokens(user_id);
