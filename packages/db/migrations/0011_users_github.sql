-- 0011_users_github (M6, github-signin): "Sign in with GitHub". `users.github_id` is the stable
-- GitHub account id (one user per account), `github_login` the login at the last sign-in.
-- `orders.customer_github_login` is copied from the creating user so M5 delivery can add the
-- customer as admin on the delivered repo.
--
-- Numbered 0011 (not 0008 as briefed): 0008 was taken by job_events_seq and 0009/0010 are
-- reserved by the parallel wave-4 streams; the runner applies files in name order.

alter table users
	add column github_id text,
	add column github_login text;
create unique index users_github_id_key on users(github_id) where github_id is not null;

alter table orders add column customer_github_login text;
