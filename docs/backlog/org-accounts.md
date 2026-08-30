# Build brief: AWS Organization + per-customer account vending

> **STATUS 2026-08-28/29:** the `@mf/org` module (vendAccount / assumeAccountRole / graduateAccount / fenced+audited deprovision) AND `infra/org` CDK (Customers OU + guardrail SCP) are BUILT + tested (ultracode waves 8–9). Onboarding `provisionCustomerAccount` (flag) + `orgs.aws_account_id` (migration 0013) wired. Still needs the operator prereqs below (catch-all email, one real vend) + the cross-account CDK deploy path (deliverable 3, not yet built).
>
> **STATUS 2026-08-30:** catch-all inbound mail is DONE — `infra/mail` deployed to eu-north-1 (`mf-mail` stack) and live-verified (a real send to `test@mjukvaruhuset.se` forwarded successfully to `hasse.lofgren@outlook.com`, `Reply-To` set to the original sender). The prerequisite below is cleared. One follow-up noted in TODO-EXTERNAL: the forwarder's `Reply-To` identity (`hasse.lofgren@outlook.com`) was verified in SES to satisfy the sandbox's recipient-must-be-verified rule — drop that once SES production access lands.
>
> **STATUS 2026-08-30 (later, with Hasse):** `infra/org` deployed (`mf-org` stack, us-east-1) and the first real account vended, moved into the Customers OU, and operated via `assumeAccountRole` — all live-verified end to end (see Prerequisites below for the account id and detail). Both operator prerequisites are now cleared. Only deliverable 3 (cross-account CDK deploy path) remains before a real customer account gets stacks deployed into it.

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
- ~~**Catch-all inbound mail on `mjukvaruhuset.se`**~~ — DONE 2026-08-30 (`infra/mail`, see STATUS above).
- ~~**One real vend done together**~~ — DONE 2026-08-30, with Hasse. `infra/org` deployed (`mf-org`
  stack, us-east-1 — Organizations is a global-service endpoint; Customers OU `ou-hh2k-uo3j4ipy`,
  guardrail SCP `p-dbhc1e9h`). Then, via `vendAccount`/`moveToCustomerOu` (`@mf/org`, run directly,
  not through the onboarding API — no real customer/org exists yet): vended account **072842666463**
  (`mf-customer-verify`, root email `aws+verify@mjukvaruhuset.se` — first real traffic through
  `infra/mail`), moved into the Customers OU, and `assumeAccountRole` into
  `OrganizationAccountAccessRole` confirmed working. All three `@mf/org` primitives now live-verified
  end to end. This is a throwaway verification account, not a real customer — safe to leave
  (governed by the guardrail SCP, near-zero cost) or graduate/remove later, deliberately, per "Do
  NOT" below. Still open: deliverable 3, the cross-account CDK deploy path (bootstrap + deploy a
  vended account's stacks) — not yet built, needed before a real customer account gets anything
  deployed into it.
- **Management-account-runs-prod tech debt**: our platform currently lives in the management
  account; best practice is org-admin-only. Migrating our own dev/qa/live into member accounts is a
  later, separate task — note it, don't do it here.
  - Confirmed with Hasse 2026-08-30: agreed this should happen **soon**, right after the first
    customer vend is verified — not urgent-urgent, but next, not indefinitely deferred. Real scope
    when it's picked up: a `Platform` OU (the Customers OU's guardrail SCP is wrong for us — it's
    built to restrict customers, not run our own stacks), 2 new vended-style accounts for
    `mjukvaruhuset-qa`/`mjukvaruhuset-live`, moving the just-built `qa` stack set (M11) into its own
    account, reworking the shared `mjukvaruhuset.se` Route 53 zone (one zone today serves
    dev/qa/live — likely NS-delegate `qa.`/`live.` into per-account zones rather than move the apex),
    and a cross-account deploy path for `deploy.sh`/CI (reuse `assumeAccountRole` from `@mf/org`).
    The current account (814967776290) keeps its role as the AWS Organization's **management**
    account regardless — that's fixed at creation and not renameable — so relabelling it
    "mjukvaruhuset-dev" is a cosmetic Organizations display-name change, not a structural fix; the
    actual fix is moving qa/live *out*, not making dev's presence here official.
  - 2026-08-30 (later): a full "phoenix" — evacuating **dev too**, so the management account ends up
    org-admin-only — is deliberately **out of scope** for the qa/live move above. It is much wider
    (re-vend the whole dev stack set: RDS data, Secrets Manager values, SES identities, `mf-mail`,
    ACM, CDK bootstrap in two regions, Route 53 apex repoint) and gets its own brief + scope when
    picked up, after the qa/live move has landed.
  - **Runbook + status now live in [phoenix.md](phoenix.md).** 2026-08-30: `mjukvaruhuset` OU
    (`ou-hh2k-mpixv5sr`) created by Hasse; `mjukvaruhuset-qa` = **212810920591** vended into it
    and cross-account access verified; platform guardrail SCP attached (`infra/org`), qa account
    CDK-bootstrapped in both regions. Steps 4–7 (CI deploy path, DNS delegation, stack move,
    per-account services) not started.

## Do NOT
Vend a real account from a test/CI run. Automate `RemoveAccountFromOrganization` (deliberate manual
step). Touch the running M5 delivery path except to add the optional target-account seam. Migrate
our own platform out of the management account (separate task).

## Verify
`npm run lint`, `npm test`, `npm run build`, `cd infra/org && npx cdk synth` (green offline).
Live verification (a real vend + cross-account deploy) is done once, manually, with Hasse.
