-- 0019_pricing_tiers: an operator-editable pricing-tier table.
--
-- Shape only — PLAN.md's "Pricing v1" is explicitly under revision as of 2026-08-30 (no tier
-- count, prices, or currency decided). Modeled on `model_prices` (migration 0018): append-only,
-- one row per (tier_key, effective_from), a later row for the same key takes over from its
-- effective_from on. Nothing reads this table yet — it exists purely so prices can be entered
-- and edited through the admin API once they are decided, without another migration.
--
-- Left unseeded on purpose: no default rows, unlike model_prices' Anthropic list-price seed.

create table pricing_tiers (
	id uuid primary key default gen_random_uuid(),
	tier_key text not null,
	name text not null,
	price numeric(12, 2) not null check (price >= 0),
	currency text not null,
	description text not null default '',
	effective_from timestamptz not null default now(),
	created_at timestamptz not null default now(),
	unique (tier_key, effective_from)
);

create index pricing_tiers_key_idx on pricing_tiers (tier_key, effective_from desc);
