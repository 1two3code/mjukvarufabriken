# Phoenix — recreate everything from nothing

The ability to stand the platform back up from an empty AWS Organization and a fresh clone —
new accounts, DNS, certs, secrets, data — with as few manual steps as possible. Two motivations:

1. **Disaster recovery / reproducibility** — a member account is compromised, a region is lost, or
   we simply want to prove the platform is not a pet. Everything reproducible from git + a runbook.
2. **Evacuate the management account** (`docs/backlog/org-accounts.md`): dev/qa/live currently share
   the Organizations management account; Phoenix moves each into its own member account so the
   management account is org-admin-only. qa/live go first (they were never in it properly); **dev
   evacuation** is the widest slice (re-vend the dev stack set: RDS data, Secrets Manager values,
   SES identities, `mf-mail`, ACM, CDK bootstrap ×2 regions, Route 53 apex repoint).

Phoenix is **not one big-bang script**. It is a set of **idempotent, re-runnable primitives** — the
same ones you use to add qa or live for the first time — composed into a runbook. If provisioning qa
works, Phoenix works; they are the same code paths.

## The primitives

| # | Primitive | Where | Idempotent? | Notes |
|---|---|---|---|---|
| P1 | Create a member account | `infra/scripts/provision-account` (Organizations `CreateAccount`) | yes (reuses ACTIVE account by name) | `mf-<env>`, root email `aws+<env>@mjukvaruhuset.se` via the catch-all; run as the management account |
| P2 | CDK bootstrap (both regions) | `provision-account` (assumes `OrganizationAccountAccessRole`) | yes | `aws://<acct>/{eu-north-1,us-east-1}`; the deploy role can't bootstrap |
| P3 | `github-deploy` stack (OIDC role) | `provision-account` (`cdk deploy github-deploy`) | yes | once per account |
| P4 | Subdomain hosted zone + NS delegation | `infra/scripts/provision-env` | yes | `qa.mjukvaruhuset.se` zone in the env account; NS record into the root zone |
| P5 | ACM certs (CloudFront us-east-1 + API eu-north-1) + DNS validation | `infra/scripts/provision-env` | yes | validated against the env's own zone; auto-renews |
| P6 | Publish per-env infra values | `infra/scripts/provision-env` → SSM / GitHub env | yes | cert ARNs, zone id, account id — **read by config, never hand-edited** (item 1) |
| P7 | GitHub environment (vars + deploy-role secret) | `provision-env` via `gh` | yes | `AWS_ACCOUNT_ID`/`AWS_REGION` vars, `AWS_DEPLOY_ROLE_ARN` secret; live gets a required reviewer |
| P8 | Deploy the stacks | `infra/scripts/deploy.sh <env>` (or the deploy workflow) | yes | resources → mf → ops → budget |
| P9 | Seed secrets + data | (dev-evacuation only) | — | Secrets Manager values, RDS restore from snapshot, SES identity re-verify |

`provision-env` (item 2 of this work) automates **P4–P7**. P1–P3 are one-liners it can call once the
account exists. P8 already exists. P9 is dev-evacuation scope only.

## The one refactor that makes it "run once, no hand-edits" (item 1)

Today `infra/lib/config.ts` **hardcodes** each env's `account`, cert ARNs and hosted-zone id (that's
why qa has `PENDING-*` placeholders you edit by hand). Phoenix recreates accounts, so those values
change every time — hand-editing source defeats the point.

**Fix:** config reads each env's `account`, `cloudFrontCertificateArn`, `apiCertificateArn`,
`hostedZoneId`/`hostedZoneName` (and `githubOAuth`/`githubDelivery`) from **environment variables**,
falling back to the committed literals so nothing changes for dev and **offline `cdk synth` still
works** (no AWS lookups — the CDK rule). `provision-env` writes those values as GitHub-environment
vars/secrets (for CI) and to a git-ignored `infra/.env.<env>` that `deploy.sh` sources (for local).
Result: after provisioning a fresh account you never touch `config.ts`.

> Env vars, not SSM dynamic references: the CloudFront cert lives in us-east-1 but is consumed by the
> eu-north-1 web stack, and `HostedZone.fromHostedZoneAttributes` wants a concrete id — SSM
> `{{resolve}}` tokens are fragile across those boundaries. Env-var injection keeps every value a
> real string at synth time and preserves offline synth via the committed fallbacks.

## Runbook — add an environment (qa shown; live differs where noted)

```
# 0. Decide root-zone ownership for the LIVE apex first (mjukvaruhuset.se can't delegate to itself):
#    keep the root zone in the live account, or a shared DNS account live reads. qa is a clean
#    subdomain and needs no such decision.

# 1. (new account) create it + bootstrap + deploy the OIDC role   [P1–P3]  — run as the MANAGEMENT account
node infra/scripts/provision-account.mjs qa            # dry-run: shows the plan
node infra/scripts/provision-account.mjs qa --apply    # → prints the account id + mf-github-deploy role arn

# 2. zone + certs + GitHub env   [P4–P7]  — also from the MANAGEMENT account, via --assume-role
#    (no profile switch: it assumes OrganizationAccountAccessRole in the new account for you)
node infra/scripts/provision-env.mjs qa --assume-role --account <acct> \
  --deploy-role-arn arn:aws:iam::<acct>:role/mf-github-deploy --parent-zone-id Z002863610X79ZE1B3K8F
node infra/scripts/provision-env.mjs qa --assume-role ... --apply    # after reviewing the plan

# 3. deploy   [P8]
infra/scripts/deploy.sh qa                          # or push/dispatch the deploy workflow
```

### Still manual (cannot be scripted)
- **SES production access** (AWS support ticket) — live email; ~1 day.
- **Root-zone ownership decision** for the live apex (above).
- **Confirm the `mf-alerts-<env>` SNS subscription email** after the first `ops-<env>` deploy.
- **Activate the `Environment` cost-allocation tag** (billing console) or budgets read 0.

## Fresh dev PC (run Claude Code elsewhere)

Cloning to a new machine needs, roughly: `nvm use` (`.nvmrc`), `npm ci` + `npm ci --prefix infra`
(+ `infra/resident`, `infra/org`, `infra/mail`, `templates/web`), Docker for local Postgres and job
images, the AWS CLI + `gh`, and a root `.env` with `AWS_*` + the local secrets. A
`scripts/bootstrap-dev.sh` that runs those installs and prints the `.env` keys you must fill is the
natural companion to this brief — captured here so it isn't forgotten (not built yet).

## Status

- item 1 (config externalization) — **done** (env-var config, `MF_ENV` build-gating).
- item 2 (`provision-env`, P4–P7) — **done**; **dry-run by default**, run against a throwaway subdomain
  once to trust the AWS-mutating paths before qa/live.
- P1–P3 (`provision-account`) — **added**; **dry-run by default**, run as the management account. P1
  (real account creation) can only be verified by a real `--apply`.
- `live` apex path (root-zone-in-account), P9 (dev evacuation), and `bootstrap-dev.sh` — later slices.
