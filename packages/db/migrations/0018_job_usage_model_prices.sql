-- 0018_job_usage_model_prices: per-job real cost + an operator-editable price table.
--
-- `jobs.tokens_used` is the budget-cap metric (`totalTokens`: cache reads weighted 0.1×) and reads
-- ~8× below the Anthropic console, so it must not be read as spend (PLAN.md M12, wave7 stream 6).
-- `usage` keeps the raw four buckets PER MODEL (`{ "<model id>": { inputTokens, outputTokens,
-- cacheReadInputTokens, cacheCreationInputTokens } }`) exactly as Anthropic meters them, and
-- `cost_usd` is that usage priced at the rows of `model_prices` in effect when the job's ORDER was
-- created — a later price change never reprices an order already placed.
--
-- `model_prices` is append-only: one row per (model-id prefix, effective_from); the newest row not
-- after the instant wins per prefix, the longest matching prefix wins per model id, and an id no
-- prefix matches prices at the Sonnet tier (`fallbackModelPrice` in @mf/models). Seeded with the
-- Anthropic list prices captured 2026-08-28 (USD per million tokens).

alter table jobs
	add column usage jsonb,
	add column cost_usd numeric(12, 4);

create table model_prices (
	id uuid primary key default gen_random_uuid(),
	model_prefix text not null,
	input numeric(10, 4) not null check (input >= 0),
	output numeric(10, 4) not null check (output >= 0),
	cache_read numeric(10, 4) not null check (cache_read >= 0),
	cache_write numeric(10, 4) not null check (cache_write >= 0),
	effective_from timestamptz not null default now(),
	created_at timestamptz not null default now(),
	unique (model_prefix, effective_from)
);

create index model_prices_prefix_idx on model_prices (model_prefix, effective_from desc);

insert into model_prices (model_prefix, input, output, cache_read, cache_write, effective_from) values
	('claude-opus', 15, 75, 1.5, 18.75, '2026-08-28T00:00:00Z'),
	('claude-sonnet', 3, 15, 0.3, 3.75, '2026-08-28T00:00:00Z'),
	('claude-haiku', 1, 5, 0.1, 1.25, '2026-08-28T00:00:00Z'),
	('claude-3-5-haiku', 0.8, 4, 0.08, 1, '2026-08-28T00:00:00Z');
