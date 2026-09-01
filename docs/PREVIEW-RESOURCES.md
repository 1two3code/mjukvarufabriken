# Preview resources for delivered apps — object storage

Companion to [DELIVERED-DB.md](DELIVERED-DB.md). That one gave a delivered preview app its own
database; this one gives it somewhere to put files. Same problem shape, same credential shape,
same fail-closed rule.

Before this, `envManifest` could detect that an app needed a bucket and nothing ever provisioned
one. The app booted, served its SPA, passed the boot smoke — and then either 500'd on every
upload, or (worse) wrote to the container's ephemeral disk, which looks like it works right up
until the next deployment silently takes every file with it. For an app whose entire point is
storing photos, that is the difference between a demo and a broken promise.

**This was the blocker for dogfood app #1** (the S-class photo PWA): an app built around uploads
could not be delivered at all.

## Design

**Who holds which credential** — the whole design, again:

- The **api** creates, per delivered app, an S3 prefix and a dedicated IAM role scoped to exactly
  that prefix (`apps/api/src/services/previewStorageService.ts`).
- The **build job** never holds storage credentials. It calls `POST /internal/jobs/:jobId/storage`
  with its per-job report token and receives back only *names*: bucket, prefix, region, role ARN.
- The **delivered app** receives `S3_BUCKET`, `S3_PREFIX` and `AWS_REGION` in its environment and
  **no keys at all**. It runs *as* the scoped role — ECS Express is created with that role as
  `taskRoleArn`, so the container reads short-lived credentials from the task metadata endpoint,
  the way any well-behaved AWS workload does.

### Why one role per app, and not one shared role

ECS has no session-tag/ABAC passthrough for task roles
([containers-roadmap#2426](https://github.com/aws/containers-roadmap/issues/2426)) — the same
finding that forced the job's own artifact uploads to self-scope through `sts:AssumeRole` with an
inline session policy. A long-running container cannot do that dance: it needs credentials that
refresh forever, which is exactly what a task role is.

So a single shared task role could only ever be scoped to `preview/*` — every delivered app able
to read and delete every other delivered app's objects, with nothing but convention in between.
That is precisely the class of weakness Gate B exists to remove, so the role is per job and the
prefix is enforced by IAM.

### The cost of that, and how it is fenced

Real isolation means the api can create IAM roles, which is a genuine expansion of what a compromise
of the api would buy an attacker. The grant in `infra/lib/web-stack.ts` is fenced four ways:

| Fence | What it stops |
|---|---|
| **Name** — `mf-preview-app-*` | Minting a role with an arbitrary name |
| **Path** — `/mf-preview/` | Touching any role outside the preview namespace |
| **Boundary** — `iam:PermissionsBoundary` must equal `mf-preview-boundary-<env>` | **The load-bearing one.** A role minted here can never hold more than "objects in the preview bucket", regardless of what policy is attached to it — even by a bug in `previewStorageService` |
| **PassRole** — `iam:PassedToService: ecs-tasks.amazonaws.com` | Handing a minted role to anything other than an ECS task, which is how a PassRole grant becomes privilege escalation |

`infra/test/security-baseline.test.ts` pins all four, and the boundary assertion is verified to
fail without the condition (mutation-tested, 3 environments).

### When it triggers

`detectStorageNeed` (`packages/harness/src/job/delivery/envManifest.ts`), same union-of-signals
approach as the database:

- a declared bucket env var (`S3_BUCKET`, `AWS_S3_BUCKET`, `STORAGE_BUCKET`, `BUCKET_NAME`), or
- an S3 client dependency (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `aws-sdk`), or
- an **upload middleware** (`multer`, `busboy`, `@fastify/multipart`, `formidable`) — an app that
  accepts a file upload has to put it somewhere, and on a preview that somewhere cannot be the
  container's disk.

Detection errs wide, deliberately: a false positive costs one empty prefix and a role nobody calls;
a false negative ships an app that loses its users' files.

### Fail closed

If an app needs storage and provisioning is unavailable (local `db`-mode runs) or errors, the
**deploy is skipped** with the reason on the `deploy` step. The repo and bundle still deliver; no
live-but-broken URL is handed out. Identical to the database rule, and to the audit's "block, don't
degrade silently" recommendation.

## Config

| Env (api) | Meaning |
|---|---|
| `PREVIEW_BUCKET` | Shared bucket delivered apps write into. Absent → provisioning is unavailable and storage-needing apps fail closed |
| `PREVIEW_ROLE_BOUNDARY_ARN` | Boundary attached to every minted role. Absent → `CreateRole` is refused by IAM, because the api's own grant requires it |
| `AWS_ACCOUNT_ID` | Written into the role's trust policy as the `aws:SourceAccount` confused-deputy guard |

Objects expire after 90 days (`infra/lib/resources-stack.ts`). A preview is not anybody's system of
record — the delivered repo is.

## Deliberately left out (and why)

- **Teardown of the role and prefix.** Belongs with the existing `deployed_services` teardown path,
  together with the provisioned database, which has the same gap. Until then a delivered app leaves
  a role behind; IAM's default quota is 1 000 roles per account, so this is not urgent but it is
  real. Tracked with the DB teardown item.
- **Email and queues.** The backlog note proposed the `log` transport for preview email; nothing in
  the delivered template sends mail yet, so the need has never fired. Queues have no signal to
  detect. Both wait for a real app that wants them.
- **Telling the worker about the bucket.** The delivered app discovers storage through its own
  required-env contract, as it already does for `DATABASE_URL`. A worker-prompt convention ("use
  `S3_BUCKET`/`S3_PREFIX` for uploads") would make detection more reliable, but any change to the
  session system prompt regenerates the replay cassette — deferred to a prompt-touching wave, the
  same call the database made.
- **Presigned-URL uploads through our api.** Strongest isolation and no IAM changes, but it couples
  the delivered app to our platform, which conflicts with ejection being a product principle. The
  app uses the plain AWS SDK, so a customer who leaves swaps the bucket and role and changes nothing
  else.
