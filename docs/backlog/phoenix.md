# Phoenix: moving our own platform out of the management account

> **STATUS 2026-08-30:** steps 1–3 done for qa — `mjukvaruhuset-qa` (**212810920591**) vended into
> the `mjukvaruhuset` OU (`ou-hh2k-mpixv5sr`), `OrganizationAccountAccessRole` verified; platform
> guardrail SCP `mf-platform-guardrail` (`p-k2ta5vq5`, `infra/org`) attached to that OU; the qa
> account is CDK-bootstrapped in eu-north-1 + us-east-1 (default qualifier). Steps 4–7 NOT
> started. `live` account not vended yet.

Best practice is that the Organization's **management** account (814967776290, fixed at creation,
not renameable) runs nothing but org administration. Today it runs dev + qa of our platform and
all the shared bits (Route 53 apex zone, SES, inbound mail, Secrets). This document is the
runbook for moving qa and live into their own member accounts now, and dev later ("full
phoenix" — much wider, own scope, see the end).

Decision trail: PLAN.md Decisions 2026-08-28; docs/backlog/org-accounts.md (account-per-customer
model, this note started as its "management-account-runs-prod tech debt" item).

## Target layout

```
Root r-hh2k
├── mjukvaruhuset (ou-hh2k-mpixv5sr)     ← our platform OU. SCP: platform guardrail (step 2)
│   ├── 814967776290 hasse.lofgren       management account (org admin; dev stays here for now)
│   ├── 212810920591 mjukvaruhuset-qa    ✅ vended 2026-08-30
│   └── <live>       mjukvaruhuset-live  (step 1, when live is first deployed)
└── Customers (ou-hh2k-uo3j4ipy)         ← vended customer accounts. SCP: mf-customers-guardrail
    └── 072842666463 mf-customer-verify  first real vend (org-accounts.md)
```

Account-per-environment for *us*; account-per-customer (envs as stacks) for customers. Different
OUs because the Customers guardrail is written to restrict customers (it would block what our own
stacks need), while our OU needs a lighter platform guardrail.

## Steps (qa first, live the same way)

### 1. Vend the account — ✅ qa
Real `CreateAccount`, slow and 90-day-close — never from CI/tests; by hand, once per env:

```sh
aws organizations create-account --account-name mjukvaruhuset-<env> \
  --email aws+mjukvaruhuset-<env>@mjukvaruhuset.se \
  --role-name OrganizationAccountAccessRole --iam-user-access-to-billing ALLOW
aws organizations describe-create-account-status --create-account-request-id <car-…>   # until SUCCEEDED
aws organizations move-account --account-id <id> --source-parent-id r-hh2k --destination-parent-id ou-hh2k-mpixv5sr
aws sts assume-role --role-arn arn:aws:iam::<id>:role/OrganizationAccountAccessRole --role-session-name verify
```
Root email goes to the catch-all (`infra/mail`); the root user is never used — access is via
`OrganizationAccountAccessRole` from the management account (later: from a dedicated deploy
role). qa: `car-1ae227b050b545618f6a36a872403066` → 212810920591.

### 2. Platform guardrail SCP on the `mjukvaruhuset` OU — ✅
`infra/org` `OrgStack` now also creates `mf-platform-guardrail` (`p-k2ta5vq5`) targeted at the
hand-made OU (`config.platformOuId`, default `ou-hh2k-mpixv5sr`; the OU is referenced, never
owned). It is built by the same `buildCustomersScp` — the four guardrails (region lock to
`eu-north-1` + `us-east-1`, deny `organizations:LeaveOrganization`, deny disabling CloudTrail,
deny the root user) are generic; a separate policy so customer-only restrictions can be added to
theirs later without touching ours. SCPs do not apply to the management account — the guardrail
protects qa/live only. Deploy: `cd infra/org && npx cdk deploy` (management account creds,
`CDK_DEFAULT_REGION=us-east-1`).

### 3. CDK bootstrap the new account (one-time, admin creds) — ✅ qa
```sh
# creds = assume OrganizationAccountAccessRole into the account
npx cdk bootstrap aws://<id>/eu-north-1 aws://<id>/us-east-1
```
Same default qualifier (`hnb659fds`) as today, so `deploy-environment.yml`'s bootstrap guard and
the `github-deploy` role's `cdk-*-role-<account>-<region>` grants work unchanged. Gotcha: run the
`cdk` binary from a directory WITHOUT `cdk.json` (or pass `--app ''`) — inside `infra/` bootstrap
synthesises the whole app first and fails on the missing built SPAs. Done for qa 2026-08-30 via
`OrganizationAccountAccessRole` (assume-role creds exported, then `cdk bootstrap` both regions).

### 4. CI deploy path for the account
- Deploy `infra`'s `github-deploy` stack INTO the new account (it is per account:
  `CDK_DEFAULT_ACCOUNT=<id> infra/scripts/deploy.sh …` with assumed-role creds, or a
  `--profile`). Output `DeployRoleArn` = `arn:aws:iam::<id>:role/mf-github-deploy`.
- GitHub environment `<env>`: vars `AWS_REGION=eu-north-1`, `AWS_ACCOUNT_ID=<id>`, secret
  `AWS_DEPLOY_ROLE_ARN`. `live` additionally gets a **required reviewer**.
- `deploy.yml`: chain `qa` (and later `live`) back onto push — the `if:` lines say how.
- `infra/lib/config.ts`: environments already read `CDK_DEFAULT_ACCOUNT`; each env now deploys
  from its own GitHub environment with its own account id, so nothing per-account lands in git.
- `infra/scripts/deploy.sh <env>`: today it uses the root `.env` creds (management account). Add
  an assume-role step keyed on `<env>` (reuse `assumeAccountRole` from `@mf/org`, or an
  `AWS_PROFILE` per env with `role_arn`/`source_profile`) so manual deploys hit the right account.

### 5. DNS + certificates
One Route 53 zone `mjukvaruhuset.se` in the management account serves dev/qa/live today. Keep
the apex there; create a **`qa.mjukvaruhuset.se` hosted zone in the qa account** and NS-delegate
it from the apex zone (4 NS records). Then in the qa account: ACM certs for
`qa.mjukvaruhuset.se` / `portal.qa.…` (us-east-1, CloudFront) and `api.qa.…` (eu-north-1), DNS
validated in the new zone; update `config.ts` `domain` for qa (zone id/name + cert ARNs). Same
for `live.` later. Site/portal/api hostnames do not change for users.

### 6. Move the qa stack set
qa is not yet load-bearing, so no data migration: deploy `resources-qa`, `mf-qa`, `ops-qa`,
`budget-qa` fresh into the qa account (CI, step 4), verify, then `cdk destroy` the old `*-qa`
stacks in the management account (RDS `RETAIN` policy → delete the orphaned snapshot/instance by
hand). live never existed in the management account, so it just lands correctly.

### 7. Per-account shared services
- Secrets Manager `mf/<env>/*` values: re-enter in the new account (the placeholders are created
  by the stacks; the values are set by hand — see TODO-EXTERNAL for the list).
- SES: verify `mjukvaruhuset.se` sending identity in the qa account (DKIM records in the new
  sub-zone or the apex), request production access again (sandbox is per account).
- Budgets/alerts topics are per stack set — nothing shared. Cost Explorer now shows qa alone.
- Inbound mail (`infra/mail`) and `infra/org` stay in the management account (org-level).

## Full phoenix (dev too) — later, own scope
Evacuating **dev** as well leaves the management account org-admin-only (the actual best
practice). Much wider than qa: dev has data (RDS), the live Stripe test-mode webhook endpoint,
the GitHub App, SES identities + the `mf-mail` receiving rules, and the apex zone all pinned to
it. Plan it as: vend `mjukvaruhuset-dev`, repeat steps 2–7, then migrate data (`pg_dump`/restore
or snapshot share), re-point Stripe/GitHub webhooks, and only then decide whether the apex zone
moves (it can stay — the management account owning DNS is acceptable). Not before qa and live
have run in their own accounts for a while.
