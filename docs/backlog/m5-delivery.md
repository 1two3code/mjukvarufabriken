# Stream: m5-delivery — repo, deployment, deliverable bundle (PLAN.md M5)

Areas: `packages/harness` (`src/job/delivery/*` new), `packages/models` (Deliverable schema),
`apps/job` (delivery step after gates), `apps/api` (`routes/bff/jobs/getDeliverables.ts`,
service), `infra` (job task role: App Runner + S3 + IAM PassRole for a per-customer service
role; `apprunner` resources are created at runtime by the job, NOT in our stacks). Do not touch
portal (m6-orders renders deliverables), persistence internals, gates internals.

## Context
After the M4 gates pass, the job has a built repo at `<workDir>/repo` (main, all tasks merged,
lint+test green, gate reports on the job row). Delivery target (PLAN.md Decisions): GitHub repo
transferred to the customer + AWS App Runner URL + bundle in the artifacts bucket
(`ARTIFACTS_BUCKET`, task role already has write). GitHub org `mjukvaruhuset` and a token do not
exist yet (TODO-EXTERNAL) — build against `GITHUB_TOKEN` env (+ `GITHUB_TOKEN_SECRET_ARN`
resolved like the Anthropic key; re-add the secret grant to the job task role that the M3 review
removed, with a comment why it is back) and make every GitHub call go through one small
`GitHubClient` interface with a fake for tests and a `--dry-run` that logs instead of calling.

## Deliverables
1. **Handover docs generated into the repo**: `HANDOVER.md` (what was built, how to run/deploy,
   where the acceptance tests are, gate summary, known limitations from the review gate's low
   findings), `README.md` refreshed for the customer's app name, `TEST-REPORT.md` (lint/test
   output tail + acceptance report table). One Agent SDK session may write the prose; the tables
   are generated deterministically from `GateReport`/`AcceptanceReport`.
2. **GitHub**: create repo `mjukvaruhuset/<order-slug>` (private), push main, add the customer
   as admin by GitHub login when `Order.customerGithubLogin` is set, else leave a
   `transfer pending` flag; record `repositoryUrl` on the job. Octokit (`@octokit/rest`) via
   the interface above.
3. **Deploy to App Runner**: the customer repo already contains its own CDK (`infra/`) from the
   template — for v1 deploy the *api* container to App Runner from the pushed repo using the
   App Runner SDK (`@aws-sdk/client-apprunner`): ECR image built by the job (`docker` is not
   available on Fargate → use App Runner's source-code deployment from the GitHub repo with an
   `apprunner.yaml` generated into the repo; GitHub connection ARN from
   `APPRUNNER_CONNECTION_ARN` env → TODO-EXTERNAL row: create the App Runner GitHub connection
   once in the console). Static SPA build goes to the artifacts bucket under
   `deliverables/<jobId>/site/` with a CloudFront-less S3 website URL for v1 (note the limitation).
   Record `deployUrl` on the job. Everything behind an interface + fake; dry-run in tests.
4. **Bundle to S3**: `deliverables/<jobId>/repo.zip` (git archive of main), `HANDOVER.md`,
   `TEST-REPORT.md`, `gates.json`, `acceptance.json`; `deliverableKey` on the job; presigned
   download URLs via `GET /bff/jobs/:jobId/deliverables` (org-scoped, 15-min expiry).
5. Events: `delivery` per step (repo, deploy, bundle) with urls; status `delivered` only when the
   bundle exists and the repo push succeeded (deploy failure → `delivered` with
   `deployUrl: null` + a `notify` event, because the repo + bundle are the contract; document).
6. Tests with fakes for every step, including dry-run mode; `packages/harness/scripts/delivery-demo.ts --repo <dir> --dry-run`.

## Verification
- `npm run lint`, `npm test`, `npm run build`, `cd infra && npx cdk synth`.
- Dry-run demo on a local repo dir. PLAN.md M5: boxes ticked as "code + dry-run verified;
  live delivery pending GitHub org / App Runner connection (TODO-EXTERNAL)".
