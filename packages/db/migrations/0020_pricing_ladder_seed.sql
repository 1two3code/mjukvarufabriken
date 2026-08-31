-- 0020_pricing_ladder_seed: seed pricing_tiers (0019) with the decided ladder.
--
-- Strategy decision 2026-08-31 (docs/backlog/strategy-2026-08-31.md): the S/M/L 15k/45k/120k
-- price list is replaced by a ladder — free spec+quote, ~500 kr voucher demo build, 3–5k kr real
-- build (hard ceiling 5 000 kr), 600 kr/mo managed subscription. S/M/L survive as internal
-- build-size classes only; `sizePricesFromTiers` (@mf/harness) reads the `build_s/m/l` rows at
-- spec freeze, so a later row for the same key reprices new quotes without a code change.
--
-- `demo` and `managed_monthly` are informational for now: the voucher flow and subscription
-- billing are not built yet (TODO-EXTERNAL: live Stripe products for the subscription).
-- All prices SEK ex moms. Deliberately a fixed timestamp (not now()) so re-created environments
-- get identical rows and any admin edit is unambiguously later.

insert into pricing_tiers (tier_key, name, price, currency, description, effective_from) values
	('demo', 'Demo build', 500, 'SEK',
		'Voucher demo build: one real problem, built small. Full amount paid upfront.',
		'2026-08-31T00:00:00Z'),
	('build_s', 'Build (small)', 3000, 'SEK',
		'Real build, size class S. Hosted; 50/50 deposit/balance split applies from 3 000 kr.',
		'2026-08-31T00:00:00Z'),
	('build_m', 'Build (medium)', 4000, 'SEK',
		'Real build, size class M. Hosted; 50/50 deposit/balance split.',
		'2026-08-31T00:00:00Z'),
	('build_l', 'Build (large)', 5000, 'SEK',
		'Real build, size class L. Hosted; 50/50 deposit/balance split. Hard price ceiling: 5 000 kr.',
		'2026-08-31T00:00:00Z'),
	('managed_monthly', 'Managed subscription (per month)', 600, 'SEK',
		'Hosting + support + resident availability. Resident/AI edit tokens metered on top at x1.5; extra AWS resources at cost +20 %. Not read by code yet (subscription billing pending live Stripe products).',
		'2026-08-31T00:00:00Z');
