-- 0025_orders_quote_token (wave 14, F1 "free spec chat with no login"): the anonymous quote.
--
-- A visitor on the public site chats with the spec engine WITHOUT an account and gets a fixed
-- quote. The spec engine is keyed by order id, so an anonymous quote is a real `orders` row whose
-- `org_id` is `anon:<32 random hex>` (no org, no user — `created_by` is null). The api mints a
-- 256-bit quote token, returns it once, and stores only its sha256 here; every anonymous read or
-- turn must present the token, and claiming the quote from a signed-in portal session (`POST
-- /bff/orders/claim`) moves the row to the session's org and CLEARS the hash, so a claimed order
-- is an ordinary order and the site's token is dead. No session — admins included — can reach an
-- `anon:*` row through the order/spec services until it is claimed, so an anonymous order can
-- never be frozen, paid or built.
--
-- GDPR: an anonymous row holds no personal data beyond what the visitor chose to type into the
-- chat (no email, no ip — the per-ip limits live in `rate_limits` for an hour). Unclaimed rows
-- are deleted by the hourly housekeeping sweep after 30 days (`anonymousQuoteRetentionDays`);
-- the partial index keeps that sweep — and only that sweep — cheap.
--
-- Forward-only and data-free: every existing row is org-owned with no token.

alter table orders add column quote_token_hash text;

create unique index orders_quote_token_hash_idx
	on orders(quote_token_hash)
	where quote_token_hash is not null;

create index orders_anonymous_created_idx
	on orders(created_at)
	where org_id like 'anon:%';
