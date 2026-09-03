-- 0023_showcases (wave 14, pricing ladder 2026-08-31): the demo gallery. An admin marks a
-- delivered order as a showcase and the public site lists the published ones as clickable demo
-- apps ("the factory is the marketing department", docs/backlog/strategy-2026-08-31.md).
--
-- One row per order, keyed by the order so the row follows the order's lifecycle: the public list
-- JOINs orders and keeps only `lifecycle = 'active'` (a suspend deletes the compute just like a
-- teardown), so a suspended or torn-down app disappears from the gallery without a hook in either
-- path. `url` is the live URL shown to visitors — it defaults to the
-- order's latest delivered deployUrl when the admin leaves it out, but is stored explicitly so the
-- gallery never has to parse job events, and an admin can point it elsewhere (a custom domain).
-- Null only on an unpublished draft: publishing requires a URL (the api refuses otherwise).
-- `sort` orders the gallery (ascending); the blurbs are the two site languages.

create table showcases (
	order_id text primary key references orders(id) on delete cascade,
	published boolean not null default false,
	title text not null,
	blurb_sv text not null default '',
	blurb_en text not null default '',
	url text,
	sort int not null default 0,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

-- The public read: published rows in gallery order. Partial so it stays as small as the gallery.
create index showcases_published_idx on showcases (sort, updated_at desc) where published;
