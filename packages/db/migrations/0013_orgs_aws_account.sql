-- 0013_orgs_aws_account (wave 9, org-onboarding-lifecycle): the vended per-customer AWS account
-- (docs/backlog/org-accounts.md #4). The onboarding `provisionCustomerAccount(orgId)` step calls
-- @mf/org `vendAccount` and records the resulting 12-digit account id (and the slug it was vended
-- under, `mf-customer-<slug>`) on the org row. Nullable: the step is behind a flag and a no-op
-- until enabled, so most orgs carry no account. Delivery/resident target this account once set.

alter table orgs
	add column aws_account_id text,
	add column aws_account_slug text;
