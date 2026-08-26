-- 0011_users_github (M6, github-signin): "Sign in with GitHub". `users.github_id` is the stable
-- GitHub account id (one user per account), `github_login` the login at the last sign-in (M5
-- delivery resolves the customer's login from the order's creator at delivery time — no
-- snapshot on the order, logins are not stable). `magic_links.purpose` tells emailed links
-- ('email', rate limited per address) from the one-shot links a provider sign-in ends in
-- ('login', never counted against that limit).
--
-- Numbered 0011 (not 0008 as briefed): 0008 was taken by job_events_seq and 0009/0010 are
-- reserved by the parallel wave-4 streams; the runner applies files in name order.

alter table users
	add column github_id text,
	add column github_login text;
create unique index users_github_id_key on users(github_id) where github_id is not null;

alter table magic_links add column purpose text not null default 'email';
