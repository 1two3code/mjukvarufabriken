# Go-Live Readiness Report — Provisioning + Deploy Path

Audience: the operator standing up / cutting over to LIVE. Every item is code-anchored and reproduced against the actual tree (deploy.sh, provision-env.mjs, config.ts, resources-stack.ts). Grouped by failure mode; a prioritized "must-fix before LIVE" list and systemic hardening follow.

---

## A. Wrong-account guard bypass — CRITICAL, blast-radius

**A1. `deploy.sh live` deploys the whole live env into the org MANAGEMENT account.** `infra/scripts/deploy.sh:41`
The guard `if [ -n "${MF_ACCOUNT:-}" ] && [ "$MF_ACCOUNT" != "$CDK_DEFAULT_ACCOUNT" ]` only fires when `MF_ACCOUNT` is set, and `MF_ACCOUNT` is only set if `infra/.env.$env` exists (line 27, conditional). provision-env refuses `live` (line 47), so `.env.live` never gets written — only `.env.qa` exists on disk. Operator runs `deploy.sh live` (accepted at deploy.sh:14) without `--assume-role`: `MF_ACCOUNT` unset → guard skipped → creds come from root `.env` AWS_* (management, 814967776290) → `config.ts:102` resolves `account = MF_ACCOUNT || CDK_DEFAULT_ACCOUNT` = management. resources-live/mf-live/ops-live/budget-live (RDS, VPC, NAT, ECR, secrets, CloudFront) synthesize pinned to and deploy into the Organizations root account, silently. `resources-live` alone (`deploy.sh live resources-live`) has no dist/cert dependency, so it lands RDS/VPC/NAT there with no abort. The same latent path already puts `dev` in management (committed dev fallback cert ARNs contain `...814967776290...`).
**Fix (fail-closed):** require a resolved target account for qa/live. Add near the top of deploy.sh:
```sh
case "$env" in qa|live) : "${MF_ACCOUNT:?refusing $env deploy: no target account resolved (need .env.$env or MF_ACCOUNT + --assume-role)}";; esac
```
and refuse to deploy when the resolved account equals the known management account.

---

## B. Missing live domain / TLS / email — CRITICAL & HIGH, silent wrong-outcome at cutover

The `live` config block (`config.ts:206`) is the only env with **no `domain`** and `email.transport:'ses'`. This cascades into four separate silent failures that all pass `/health` and report deploy success.

**B1. Live magic-link email is dead on arrival — admin locked out. (CRITICAL)** `config.ts:211` + `resources-stack.ts:211,216`
`email.transport:'ses'` is set for live, but the SES `EmailIdentity` and the `ses:SendEmail` grant are created only `if (environment.domain)` (resources-stack.ts:211; web-stack ~256). `EMAIL_TRANSPORT=ses` is passed straight through (web-stack.ts:181) and `parseEmailTransport` forces `ses` for live regardless. On a domainless live deploy the api runs the real SES transport with (a) no verified identity → MessageRejected, and (b) no IAM grant → AccessDenied. live also has no `githubOAuth`, so magic-link is the ONLY sign-in path → nobody, including the sole admin, can authenticate to production. The web-stack.ts comment "runs the log transport instead" is false.
**Fix:** add a live `domain` block and provision the SES identity before cutover; and add a deploy-time assertion in bin/app.ts / config that refuses `live` unless `domain` is present (or coerces transport to `log` when no identity exists). Note the downstream SES-sandbox step (production-access ticket) is still required — track in TODO-EXTERNAL.

**B2. Live serves on `*.cloudfront.net` + plaintext ALB, no fallback literals. (HIGH)** `config.ts:206`, web-stack.ts:125-127,315
With `domain` absent, SPAs get CloudFront default domains, the API is `http://<alb-dns>`, and no A-records/ACM are attached (`if (domain && hostedZone)`). Unlike qa (which has PENDING cert literals that fail closed against CloudFront/ALB), live has no cert literals, so nothing forces the domain to be configured — the deploy silently succeeds on random URLs. The token issuer becomes `http://<alb-dns>`, so any tokens minted pre-domain are invalidated once the domain is wired.
**Fix:** same domain-required guard as B1; commit live cert/zone fallbacks or make missing live cert ARNs fail synth the way qa's PENDING placeholders do.

**B3. Live build-job bearer tokens cross NAT → public ALB in cleartext. (HIGH)** `web-stack.ts:226`
Consequence of B2: `apiUrl` undefined → `JOB_API_URL = http://<public-ALB-DNS>`. Per-job `JOB_TOKEN` bearer credentials travel Fargate → NAT → public ALB over plaintext HTTP. The only guard is `cdk.Annotations.addWarning` (web-stack.ts:222) which does NOT fail synth (`--require-approval never`, no `--strict`). Every production build job leaks an interceptable auth token until a domain is added.
**Fix:** resolved by B1/B2 (domain ⇒ HTTPS api URL). Additionally make the annotation a synth-failing error for `env==='live'`.

---

## C. Cert idempotency & PENDING-ARN publication — HIGH, wedges the cutover

**C1. ensureCert selects by DomainName only, no status check — dead-ends on VALIDATION_TIMED_OUT/FAILED.** `provision-env.mjs:149`
`list.find(c => c.DomainName === primaryDomain)` matches the first cert for the domain regardless of status. If an earlier run's cert went terminal (`VALIDATION_TIMED_OUT` after ACM's 72h window, or `FAILED`), a re-run latches onto that dead ARN, re-adds validation records that do nothing to a terminal cert, and `acm wait certificate-validated` (line ~185) never returns ISSUED. The script can never self-heal — the only fix is manually deleting the cert in ACM. `list-certificates` returns all statuses by default, so the dead cert is matched.
**Fix:** filter the match to `Status === 'ISSUED' || Status === 'PENDING_VALIDATION'`; if a matching cert is terminal, request a fresh one.

**C2. Publishes cert ARN and exits 0 even when the cert never reached ISSUED.** `provision-env.mjs:~187` (catch), persistence at ~214/231
On wait timeout the catch only logs "not ISSUED within the wait window … re-run to confirm" — no non-zero exit. The script continues, writes the still-PENDING ARN to the GitHub env var and `infra/.env.<env>`, and prints "✅ applied". Operator proceeds to `deploy.sh` (P8); CloudFront requires the ACM cert be ISSUED at distribution-create time and the ALB HTTPS listener likewise (`Certificate.fromCertificateArn`, web-stack.ts:88,159), so CloudFormation rolls the web stack back — and the GitHub var still points at the unusable cert, so retry repeats.
**Fix:** on wait timeout, re-`describe-certificate`; if not ISSUED, exit non-zero and do NOT persist the ARN (or persist but print a loud "NOT ISSUED — do not deploy" and set a failing exit code).

**C3. Reuse ignores SANs — adopts a cert that doesn't cover the portal host. (MEDIUM)** `provision-env.mjs:149`
The match never verifies the found cert's `SubjectAlternativeNames` include the portal SAN (passed at ~line 195). A hand-created or externally-added cert for `<env>.mjukvaruhuset.se` without the portal SAN is silently adopted; CloudFront then serves `portal.<env>` on a cert that doesn't list it → TLS SNI mismatch in every browser, script reports success. (The script's own creation path always includes the SAN, so this needs an out-of-band cert — hence medium.)
**Fix:** require the reuse predicate to cover primary AND every SAN.

---

## D. NS-delegation credentials & swallowed failures — MEDIUM, silent false-success

**D1. Parent-zone NS write hardcodes management creds and swallows failure; exits 0.** `provision-env.mjs:135` (write), `:136-139` (swallow)
The `change-resource-record-sets` into `--parent-zone-id` always runs with `{ env: process.env }` regardless of `--assume-role`, with no check that the caller owns the parent zone. On failure the catch only prints "add this NS delegation by hand" and continues; the run still writes config and prints "✅ applied" with exit 0. Two reachable failures: (a) direct-auth (no `--assume-role`) run where `process.env` is the TARGET creds → cannot write the management root zone; (b) the documented live cutover where the root/apex zone is moved into the live (or dedicated DNS) account — management creds then have no route53 permission on it. Either way the delegation never lands, certs never validate (chains into C1/C2), and there is no non-zero signal. There is also no guard that `parentZoneId` actually owns `mjukvaruhuset.se`, so a mistyped id UPSERTs an NS record into an unrelated zone.
**Fix:** choose delegation creds from the account that owns `parentZoneId` (explicit flag or lookup); make a delegation-write failure a hard non-zero error, not a swallowed log; assert the parent zone name is a suffix of the subdomain before writing.

---

## E. Secret bootstrap defeats fail-closed guards — CRITICAL & HIGH

**E1. Non-empty random placeholder secrets defeat the api's `required in live` guards.** `resources-stack.ts:156-161`
`createSecret()` uses `generateSecretString: { excludePunctuation:true, passwordLength:32 }` with no template → a raw 32-char random string, never empty. The api boot guard is `if (!secretKey) { if (env==='live') throw ... }` (stripe.ts:274). Because the placeholder is non-empty, `!secretKey` is false, the live guard never throws, and `new Stripe(<32 junk chars>)` (no construction validation) logs "test mode" (junk ≠ `sk_live`), passes `/health`, deploy reports success. First real Checkout → 401 Invalid API Key; `stripe-webhook-secret` junk → `constructEvent` fails signature on every webhook (400), no payment ever marked paid. Same root cause silently mis-boots `anthropic-api-key` (spec engine + every build job "have" a key) and the github-* secrets. The auth-jwt custom-resource fix patched one symptom of this class; the guard-defeating random placeholder remains for all the others.
**Fix:** seed these as empty strings (`SecretValue.unsafePlainText('')`) so `!secretKey` fires, or validate key shape (`sk_`/`whsec_`/JWK) at boot so `required in live` actually fails closed. The load-bearing safety net (the `required in live` throw) is currently provably dead.

**E2. AuthKeySeed custom resource fails OPEN to key regeneration.** `resources-stack.ts:191-195`
`let valid=false; try{ ...valid = kty==='OKP' && crv==='Ed25519' && !!d }catch(e){}; if(!valid){ generate + PutSecretValue }`. The catch discards the error, so a transient GetSecretValue failure (SecretsManager throttle, KMS hiccup, IAM eventual-consistency on re-invoke) is indistinguishable from "invalid key" → the handler OVERWRITES the existing key. In live: every issued access token is invalidated (all users forced to re-auth) and every cached-JWKS verifier (ECS Express preview services, residents) rejects tokens until re-fetch. Fires whenever the custom resource is re-invoked (serviceToken change on a provider-Lambda replacement, or a properties change — e.g. a CDK upgrade) and the read momentarily fails. The prior key survives as `AWSPREVIOUS` (manually recoverable), but the api reads `AWSCURRENT`, so the token-invalidation blast is immediate and needs manual incident recovery.
**Fix:** gate on a distinguishable outcome — treat a *successful read of a valid key* as "keep", a *successful read of an absent/invalid key* as "generate", and a *failed read* as `throw` (abort, do not regenerate). Catch `ResourceNotFoundException` specifically for the first-seed case.

---

## F. Non-idempotent stand-up / rollback traps — HIGH & CRITICAL, one-way doors

**F1. RDS `deletionProtection:true` wedges rollback of a failed first live resources deploy. (CRITICAL)** `resources-stack.ts:132`
Live DB is `deletionProtection: isLive` (true), `removalPolicy: SNAPSHOT`. First `deploy.sh live`: RDS finishes CREATE (~10-15 min) with protection ON, then a later resource in the same stack fails (AuthKeySeed error, IAM/ECR name collision, or the ECS Express managed-policy ARN flagged unverified at ~lines 353-361). CloudFormation enters ROLLBACK, calls DeleteDBInstance, RDS refuses (protection on regardless of SNAPSHOT). Stack lands ROLLBACK_FAILED / DELETE_FAILED and cannot proceed or be deleted until an operator manually `modify-db-instance --no-deletion-protection` on the exact instance then continue-rollback. The highest-stakes env's very first deploy is not self-recovering.
**Fix:** deploy resources-live in a first pass with `deletionProtection:false`, then flip it on in a follow-up deploy; or split RDS into its own stack so a mid-stack failure elsewhere doesn't try to delete a protected DB.

**F2. Fixed-name secrets block a clean retry after any resources-`<env>` rollback. (HIGH)** `resources-stack.ts:158,161`
All six secrets use deterministic `mf/<env>/<name>`; removalPolicy DESTROY (dev/qa) / RETAIN (live). CDK does not set `ForceDeleteWithoutRecovery`, so a DESTROY schedules deletion with the name reserved for the recovery window (default up to 30 days); RETAIN orphans the secret. If a create fails after the secrets are made (RDS create fails, AuthKeySeed errors): dev/qa retry hits `InvalidRequestException: a secret with this name is already scheduled for deletion` for all six → retry itself rolls back, looping until a manual `restore-secret` / `delete-secret --force-delete-without-recovery`. In live the RETAINed names collide with "already exists" on every retry. The stand-up is not safely repeatable — exactly the property a live cutover needs.
**Fix:** for dev/qa set `ForceDeleteWithoutRecovery` (or `RestoreSecret` preflight); for live, either accept RETAIN and script an explicit name-reclaim step in the runbook, or make the retry path detect scheduled-for-deletion secrets and restore them. A preflight (see G) should detect and reconcile these before deploy.

**F3. Live RETAIN + fixed names orphan ECR repo and log groups, blocking retry. (HIGH)** `resources-stack.ts:293` (repo), `:248,:303`, web-stack.ts:143
Live RETAIN with fixed `mf-deliverables-live` (emptyOnDelete false), `/mf/live/jobs`, `/mf/live/express`, `/mf/live/api`. These have no dependency on the risky ECS infra role, so they're created early; a rolled-back first live create leaves them behind unmanaged, and the next attempt hits "repository already exists" / "log group already exists". Every retry fails identically until each is manually deleted. (Auto-named S3/SPA buckets retry cleanly — fixed-name+RETAIN is the trigger.)
**Fix:** same class as F2 — preflight name-reclaim, or drop fixed physical names on the RETAIN resources so a recreate gets a fresh unique name.

---

## G. CreateAccount / hosted-zone idempotency on rerun — HIGH & MEDIUM

**G1. `create-hosted-zone` caller-reference is `Date.now()` — defeats Route53 idempotency, risks split-brain NS. (HIGH)** `provision-env.mjs:114`
The only guard against a second zone for the same name is the eventually-consistent `list-hosted-zones-by-name` find (lines 107-108); Route53 permits multiple zones for one name, each with a different authoritative NS set. If run 1 fires create-hosted-zone then dies before finishing, and on re-run the list hasn't yet surfaced the new zone, `find` misses and a SECOND `qa.mjukvaruhuset.se` zone is created with different NS. The run then reads NS/zoneId from whichever `find` returns and publishes it; if the parent delegation and the config/CI zoneId resolve to different duplicate zones, the ACM validation CNAMEs land in a zone the internet isn't delegated to → certs never validate / wrong-zone DNS. (Note: a deterministic caller-reference would return `HostedZoneAlreadyExists` rather than silently duping — that's the desired loud behavior.)
**Fix:** derive caller-reference deterministically (`mf-${env}-zone`) so a retry is a no-op/loud error, and fail loudly if `list-hosted-zones-by-name` returns more than one zone for the name.

**G2. CreateAccount re-run in the in-flight window re-fires the same root email. (MEDIUM)** `provision-account.mjs:68`
P1 guards create-account by scanning `list-accounts` (line 57-60). If a prior `--apply` fired create-account then died during the 5-min poll (or hit the deadline), the `reqId` lives only in that run's memory — the script never calls `list-create-account-status`. On re-run, if the account is still IN_PROGRESS or list-accounts is lagging, `find` misses and create-account fires again with the same root email → AWS drives the second request to FAILED (CONCURRENT_ACCOUNT_MODIFICATION / EMAIL_ALREADY_EXISTS) → hard non-zero exit, opaque scary output while the first account is actually fine. Self-heals on a later re-run once lag clears, but the operator has no signal. Root email is a one-shot resource, so double-firing at it is alarming during live account creation.
**Fix:** before create-account, reconcile `organizations list-create-account-status` for an IN_PROGRESS/SUCCEEDED request matching this email and resume its poll instead of firing again.

---

## H. Session-token expiry mid-deploy — HIGH

**H1. Cross-account assume-role uses default 3600s; a cold live deploy outlives the token.** `deploy.sh:33` (and provision-account.mjs:90)
No `--duration-seconds` anywhere → the assumed OrganizationAccountAccessRole session is 3600s and the exported `AWS_SESSION_TOKEN` is static (the CDK CLI does not refresh env-var creds mid-run). A first-time live deploy of resources-live + mf-live + ops-live + budget-live (RDS ~10-15 min, CloudFront ~15-25 min, ECS stabilization, ACM/ALB wiring) routinely exceeds 60 min. When the token expires, CFN operations already submitted keep running under the service role, but the next CDK action needing creds (asset publish, next stack DescribeStacks, CloudFront invalidation) fails `ExpiredToken` → the run aborts between stacks, leaving a partially-provisioned live env at the most expensive step.
**Fix:** pass `--duration-seconds 3600` (up to the role's `MaxSessionDuration`) and raise `OrganizationAccountAccessRole` MaxSessionDuration so long live deploys complete; or use a `credential_process` that auto-refreshes rather than static env vars.

---

## MUST-FIX BEFORE POINTING AT LIVE (irreversible / expensive-to-recover first)

1. **A1 — wrong-account guard fail-closed (`deploy.sh:41`).** Highest blast radius: production RDS/CloudFront/NAT stood up inside the Organizations management account, silently, mixed with org governance. Make qa/live refuse to deploy without a resolved non-management target account. *Do this first.*
2. **F1 — RDS deletionProtection wedges first-live rollback (`resources-stack.ts:132`).** A single mid-stack failure leaves resources-live in ROLLBACK_FAILED requiring manual RDS surgery. Deploy protection-off first, flip on after, or isolate RDS in its own stack.
3. **E1 — random placeholder secrets defeat `required in live` (`resources-stack.ts:156`).** The one guard meant to stop a live boot on junk Stripe/Anthropic keys is provably dead. Seed empty or validate key shape at boot.
4. **B1 — live magic-link email dead on arrival (`config.ts:211` + `resources-stack.ts:211`).** No domain ⇒ no SES identity/grant ⇒ sole admin cannot log into production. Add live `domain` + identity, and guard `live` to require a domain.
5. **F2/F3 — fixed-name secrets/ECR/log-groups block retry after any rollback (`resources-stack.ts:158,293,248,303`).** Turns a single failed first-live create into a manual name-reclaim loop on the RETAIN env. Add force-delete (dev/qa) / preflight name-reclaim (live).
6. **E2 — AuthKeySeed fails open to key regeneration (`resources-stack.ts:192`).** A transient read error during a re-invoke silently rotates the live signing key and invalidates every token. Make a read failure abort.
7. **C1/C2 — non-ISSUED cert latched/published, deploy rolls back (`provision-env.mjs:149,187`).** Terminal-cert dead-end has no self-heal; PENDING ARN published with exit 0 wedges the cutover deploy. Status-check the match and fail non-zero on non-ISSUED.
8. **B2/B3 — domainless live serves on `*.cloudfront.net` + plaintext ALB, leaks job tokens in cleartext.** Same root cause as B1; close together.
9. **H1 — 3600s token aborts a >60-min cold live deploy (`deploy.sh:33`).** Not irreversible but strands a half-built live env; cheap to fix.

Lower-priority (address but not cutover-blocking): D1 (delegation cred/swallow — bites the live root-zone-move path specifically), C3 (SAN reuse), G1 (hosted-zone caller-reference), G2 (CreateAccount reconciliation).

---

## SYSTEMIC HARDENING — close whole classes

- **A preflight/`--check` gate before every qa/live deploy** that (a) refuses when the resolved account is the management account or unresolved (kills A1 and the latent dev-in-management path), (b) asserts every cert ARN in `.env.<env>`/GitHub vars is `ISSUED` via `describe-certificate` (kills C2 and the cert-rollback class), (c) asserts each required secret's value is non-placeholder / correct-shape (`sk_`, `whsec_`, valid Ed25519 JWK) (kills E1's blast radius), (d) reconciles scheduled-for-deletion secret names and orphaned ECR/log-group names before CreateSecret runs (kills F2/F3), and (e) for live asserts `domain` is present with an SES identity (kills B-class). This one gate closes A, B, C-persist, E1, and F-name at deploy time.

- **Make provisioning fail closed, not "✅ applied".** provision-env swallows the delegation write (D1) and the cert wait (C2) yet exits 0. Introduce a run-level `failures[]` accumulator: any swallowed step appends to it, and the script exits non-zero with a summary instead of printing success. Removes the entire "silent half-provisioned env reported as done" class.

- **Deterministic idempotency tokens everywhere.** caller-reference (G1), a persisted/reconciled CreateAccount request id (G2), status-and-SAN-checked cert reuse (C1/C3). Rule: every "does it already exist?" check must be authoritative (direct describe by deterministic id), never an eventually-consistent `list().find()`.

- **`ForceDeleteWithoutRecovery` for non-live secrets + drop fixed physical names on RETAIN resources**, or a scripted name-reclaim step in PHOENIX. Makes teardown-recreate and failed-create-retry idempotent (F2/F3).

- **Long-lived / auto-refreshing deploy credentials.** `--duration-seconds` on every assume-role plus a `credential_process`, so no deploy is racing a 3600s clock (H1).

- **Turn the two acknowledged CDK `addWarning`s into synth-failing errors for `env==='live'`** (plaintext job-token path B3, and any domain-missing condition), since `--require-approval never` + no `--strict` means warnings never block.

Key confirmed anchors: `deploy.sh:41`, `config.ts:102` (`account = MF_ACCOUNT || CDK_DEFAULT_ACCOUNT`), `config.ts:206` (live block, no `domain`, `email.transport:'ses'` at :211), `resources-stack.ts:132` (deletionProtection), `:158-161` (fixed secret names + random generateSecretString), `:192-195` (AuthKeySeed fail-open), `:211` (SES only `if domain`), `:248/:293/:303` (RETAIN fixed-name log groups + ECR), `provision-env.mjs:114` (Date.now caller-reference), `:135` (hardcoded process.env delegation write), `:149` (DomainName-only cert match), `:187` (swallowed cert-wait), `provision-account.mjs:68`.