# infra/org — AWS Organization governance

A standalone CDK app deployed **once, into the management account** (`814967776290`, org
`o-6lnoiunxku`). It is the org-governance half of `docs/backlog/org-accounts.md` deliverable 2: it
creates the `Customers` organizational unit that every vended customer account is moved into, and
the service control policy (SCP) that guardrails those accounts.

It is **not** an npm workspace (like `infra/resident`, it stands alone so a management-account
operator can deploy it without the monorepo toolchain):

```sh
npm i --prefix infra/org
cd infra/org && npx cdk synth   # green offline — no AWS calls at synth
```

## What it creates

| Resource | Purpose |
| --- | --- |
| `AWS::Organizations::OrganizationalUnit` **Customers** | Under the org root (`r-hh2k`). `@mf/org`'s `vendAccount()` / `moveToCustomerOu()` move each new account here. |
| `AWS::Organizations::Policy` **mf-customers-guardrail** (SCP) | Attached to the Customers OU. Four guardrails, below. |

### The guardrail SCP

An SCP only ever *removes* permissions; it grants nothing and never applies to the management
account itself. `lib/customers-scp.ts`:

1. **Region lock** — deny every action whose `aws:RequestedRegion` is not `eu-north-1` (our
   workloads) or `us-east-1` (ACM certificates for CloudFront, and AWS Budgets — the two things
   that only live there). Global/partition-wide services (IAM, Organizations, STS, CloudFront,
   Route 53, ACM, Budgets, …) are exempted via `NotAction` so the lock doesn't brick them.
2. **Deny `organizations:LeaveOrganization`** — a member account can't yank itself out. Graduation
   is a deliberate `MoveAccount` / `RemoveAccountFromOrganization` run from the management account.
3. **Deny disabling CloudTrail** — `StopLogging`, `DeleteTrail`, `UpdateTrail`, `PutEventSelectors`
   are denied so the audit trail can't be turned off or blinded.
4. **Deny root-user actions** — anything performed by `arn:aws:iam::*:root` is denied, forcing all
   activity through IAM roles/users.

## Why synth is offline

The org, its root, and the `SERVICE_CONTROL_POLICY` policy type already exist and are enabled (see
the backlog brief). This stack owns only the OU and the policy. The root id it hangs the OU off is
**configuration** (`lib/config.ts`, default `r-hh2k`), not an `organizations:ListRoots` lookup —
so `cdk synth` makes no AWS calls and stays green in CI. Override per-org with
`-c rootId=r-xxxx` (or `ORG_ROOT_ID`) and the allow-list with `-c allowedRegions=eu-north-1,...`.

## One-time deploy (management account)

Deploy this **once**, with credentials for the management account (our IAM user `hasse` can call
Organizations; a dedicated deploy role is a later, optional deliverable). It is not part of any
per-customer or per-env pipeline.

```sh
npm i --prefix infra/org
cd infra/org
npx cdk bootstrap                     # once per account/region, if not already bootstrapped
npx cdk deploy -c rootId=r-hh2k       # creates the Customers OU + attaches the SCP
```

After deploy, the `CustomersOuId` and `CustomersScpId` outputs feed `@mf/org`'s account-vending
(`moveToCustomerOu`). Re-running `cdk deploy` is safe and idempotent.

> **Operator note:** applying the SCP is what makes region-lock and the root/CloudTrail/leave-org
> denies real. Sanity-check that our own management-account workloads are unaffected — an SCP never
> applies to the management account, but confirm before relying on it. Tightening or widening the
> allowed regions is an edit to `allowedRegions` followed by a redeploy.
