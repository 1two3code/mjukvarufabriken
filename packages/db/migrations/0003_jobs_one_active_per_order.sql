-- 0003_jobs_one_active_per_order (M3 review #14): the "one active job per order" rule is
-- enforced by the database, not only by the api's read-then-insert (two concurrent POSTs
-- otherwise both start a Fargate task). The api maps the unique violation to 409.

create unique index jobs_one_active_per_order
	on jobs(order_id)
	where status in ('queued', 'planning', 'building', 'verifying');
