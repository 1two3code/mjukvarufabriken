# Build brief: AWS Organization + per-customer account vending

Decision recorded in PLAN.md Decisions 2026-08-28. This is the multi-tenant foundation for M11
(customer environments) and M8 (resident agent): each customer gets an isolated AWS account we
vend and operate; the customer can graduate by moving the account out of the org.

## What exists already
- Org `o-6lnoiunxku`, management account **814967776290**, FeatureSet **ALL**, SCP policy type
  **enabled** on root `r-hh2k`. Only the management account is a member so far.
- Our IAM user `hasse` (in the management account) can call Organizations APIs (verified).
- `infra/resident/` is a standalone CDK app already designed to deploy the resident into "a
  customer account" — it becomes the thing deployed into a **vended** account.

## The model (decided)
- **Account-per-customer** (not per-env). The three envs (dev/qa/live) are separate CDK stacks
  inside the one customer account for v1; account-per-env is a later enterprise tier.
- We operate each account by assuming the auto-created **`OrganizationAccountAccessRole`** from the
  management (or a dedicated deploy) account.
- Consolidated billing rolls each account's spend up for the resident monthly fee + tokens × 1.5.
- Graduation = `MoveAccount` out of our org / invite to theirs. No data migration.

## Deliverables (build; unit-test against mocked AWS — do NOT vend a real account in CI)
1. **`packages/org` (`@mf/org`)** — an account-vending + cross-account module, injectable AWS
   clients (fakes for tests), used by onboarding and by delivery/resident:
   - `vendAccount({ customerSlug })`: `organizations:CreateAccount` (account name
     `mf-customer-<slug>`, root email `aws+<slug>@mjukvaruhuset.se`, `RoleName:
     OrganizationAccountAccessRole`) → poll `DescribeCreateAccountStatus` until `SUCCEEDED`/`FAILED`
     (honour a signal/timeout) → return the account id. Idempotent: if an account for the slug
     already exists in the customer OU, return it instead of creating a second.
   - `moveToCustomerOu(accountId)`: move the new account from Root into the `Customers` OU.
   - `assumeAccountRole(accountId)`: STS `AssumeRole` into
     `arn:aws:iam::<accountId>:role/OrganizationAccountAccessRole` → temporary credentials for the
     CDK/SDK calls that deploy into that account.
   - `graduateAccount(accountId)`: helper wrapping `MoveAccount` out of the Customers OU / the
     `RemoveAccountFromOrganization` flow (documented; the actual removal is a deliberate manual
     step, not automated).
2. **`infra/org/` CDK app** (separate, like `infra/resident`) — the org governance, deployed once
   into the management account:
   - A `Customers` OU under root.
   - An **SCP** on the Customers OU: region-lock to `eu-north-1` (+ `us-east-1` for the ACM/budget
     exceptions we already use), deny `organizations:LeaveOrganization`, deny disabling CloudTrail,
     deny root-user actions. Written so `cdk synth` is green offline.
   - (Optional, later) a dedicated deploy role in the management account that delivery/resident
     assume, rather than using `hasse` directly.
3. **Cross-account CDK deploy path**: a bootstrap + deploy helper that (a) `cdk bootstrap`s a vended
   account with a trust to our deploy account, then (b) deploys the customer's stacks (the three
   env stacks; for now, reuse the resident/express stacks) using the assumed-role credentials
   (`cdk deploy --role-arn` or credential env). Document the one-time bootstrap-per-account cost.
4. **Wire onboarding**: `jobService`/order flow gains a `provisionCustomerAccount(orgId)` step
   (behind a flag; no-op until enabled) that vends + records the account id on the org row
   (migration for `orgs.aws_account_id`). Delivery/resident then target that account.
5. Tests: `vendAccount` (create → poll → id; already-exists → reuse; failure surfaces the reason),
   `assumeAccountRole`, the SCP/OU synth, and the onboarding step — all against injected fakes.

## Prerequisites (Hasse / out-of-band — flag, don't block the build)
- **Catch-all inbound mail on `mjukvaruhuset.se`** for `aws+<slug>@…` root emails (we only send
  today via SES). Without deliverable root emails, account creation + root recovery break. → TODO-EXTERNAL.
- **One real vend done together** when ready — `CreateAccount` makes a real account (slow, 90-day
  close), so keep it out of CI and out of casual runs.
- **Management-account-runs-prod tech debt**: our platform currently lives in the management
  account; best practice is org-admin-only. Migrating our own dev/qa/live into member accounts is a
  later, separate task — note it, don't do it here.

## Do NOT
Vend a real account from a test/CI run. Automate `RemoveAccountFromOrganization` (deliberate manual
step). Touch the running M5 delivery path except to add the optional target-account seam. Migrate
our own platform out of the management account (separate task).

## Verify
`npm run lint`, `npm test`, `npm run build`, `cd infra/org && npx cdk synth` (green offline).
Live verification (a real vend + cross-account deploy) is done once, manually, with Hasse.
