# Stream: ecs-express — replace the App Runner deploy client with ECS Express Mode

Areas: `packages/harness/src/job/delivery/*`, `packages/harness/test/job/delivery/*`, `apps/job/src/config.ts`,
`infra/lib/resources-stack.ts` + `infra/lib/config.ts`. Do NOT touch the sign-in code, the gates, the
harness orchestrator, or the resident stack. Keep `npm run lint`, `npm test` and **`npm run e2e`** green.

## Why
Customer apps were going to deploy to **App Runner**, but App Runner stops taking new customers
(2026-04-30) and isn't in eu-north-1. AWS's replacement is **Amazon ECS Express Mode**, which IS in
eu-north-1. Unlike App Runner (which built from the GitHub repo), Express Mode takes a **prebuilt
container image (ECR URI)** and returns a managed HTTPS URL. So the deploy client must (1) build the
customer image and push it to ECR, then (2) create an Express Mode service from that image.

## Verified AWS API (checked against docs 2026-08-28 — cite in comments)
- SDK: `@aws-sdk/client-ecs` **`CreateExpressGatewayServiceCommand`** (distinct from `CreateService`).
  Params: `infrastructureRoleArn` (required, the managed policy `AmazonECSInfrastructureRoleforExpressGatewayServices`),
  `executionRoleArn`, `serviceName`, `cluster` (default `default`), `healthCheckPath` (default `/ping`),
  `taskRoleArn`, `cpu` (default `"256"`), `memory` (default `"512"`), `tags`, and
  `primaryContainer: { image (required), containerPort (default 80), environment: [{name,value}],
  secrets: [{name,valueFrom}], awsLogsConfiguration: { logGroup, logStreamPrefix }, command }`.
- Response is the service **directly** (no separate describe): `service.serviceArn`,
  `service.status.statusCode` (ACTIVE|DRAINING|INACTIVE), and the URL at
  **`service.activeConfigurations[0].ingressPaths[]`** where an entry with `accessType: 'PUBLIC'` has
  `endpoint` (a hostname) → the app URL is `https://<endpoint>`.
- There is a `DescribeExpressGatewayServiceCommand` for polling if the endpoint isn't populated yet.
- The whole real AWS client is **live-unverified** (post-cutoff API); mark it clearly and keep it
  behind an injectable interface with a fake, exactly like the current `appRunnerClient.ts`.

## Deliverables
1. **`packages/harness/src/job/delivery/ecsExpress.ts`** (replaces `appRunner.ts`): a `DeployClient`
   whose `deployFromRepo({ serviceName, repositoryUrl, branch, signal })`:
   a. Builds the image (step 2 below) → an ECR image URI.
   b. `CreateExpressGatewayServiceCommand` with that image + the two role ARNs + `containerPort`
      (the template api listens on 80 — check `apps/api/Dockerfile`/the generated app) + the api's
      auth env (`AUTH_ISSUER`/`AUTH_JWKS_URL`/`AUTH_AUDIENCE`, the same `previewAuth` the App Runner
      client used) + a log group + the `Service=mf-delivery` tag (keep the IAM fence).
   c. Extracts the PUBLIC `ingressPaths[].endpoint` → returns `{ url: 'https://<endpoint>' }`;
      polls `DescribeExpressGatewayService` (respecting `signal`) if not present yet.
   Unique service name per job (keep `mf-<job8>-<slug>`, ≤ the Express limit) so redeliveries don't
   collide — no reuse logic needed for v1.
2. **Image build (`packages/harness/src/job/delivery/imageBuild.ts`)** behind an `ImageBuilderLike`
   interface (fake for tests): build via **AWS CodeBuild** from an **S3 source zip** (the delivery
   already makes `repo.zip` — upload the built repo as the CodeBuild source, no GitHub creds needed in
   CodeBuild). `codebuild:StartBuild` with env overrides (ECR repo, image tag = job id) → poll
   `codebuild:BatchGetBuilds` until `SUCCEEDED`/`FAILED` (honour `signal`). The CodeBuild project +
   its buildspec (docker build + `aws ecr get-login-password` + push) live in infra. Returns the ECR
   image URI. Real client `@aws-sdk/client-codebuild`.
3. **`index.ts` `createLiveDeliveryClients`**: replace the App Runner branch. New options (from
   apps/job env): `ecrRepositoryUri`, `codeBuildProject`, `expressExecutionRoleArn`,
   `expressInfrastructureRoleArn`, `cluster`, plus the existing `previewAuth`, `region`, `artifactsBucket`.
   Missing any → `deployFromRepo: notConfigured('ECS_EXPRESS (...)')` (fails the deploy step closed,
   never the build). Update `createFakeDeployClient`/`createDryRunDeployClient` (URL format
   `https://<name>.<region>.on.aws` or similar placeholder — pick one and keep it consistent; it's
   cosmetic for the fake). Remove `apprunner.yaml` generation from the docs step (`docs.ts`) — Express
   doesn't use it; the generated repo keeps its own `infra/` as the real deploy, note that in HANDOVER.
4. **apps/job/src/config.ts**: resolve the new env (`ECR_REPOSITORY_URI`, `CODEBUILD_PROJECT`,
   `EXPRESS_EXECUTION_ROLE_ARN`, `EXPRESS_INFRASTRUCTURE_ROLE_ARN`, `ECS_CLUSTER`); drop the
   `appRunner*` fields.
5. **infra** (`resources-stack.ts` + `config.ts`): add an **ECR repo** (`mf-deliverables-<env>`,
   lifecycle: expire untagged after N days), a **CodeBuild project** (`mf-delivery-build-<env>`,
   privileged for docker, source = S3, its own role: ECR push + logs + read the source bucket), the
   **task-execution role** and the **infrastructure role** (attach the managed
   `AmazonECSInfrastructureRoleforExpressGatewayServices` + AmazonECSTaskExecutionRolePolicy), and grant
   the **job task role**: `codebuild:StartBuild`+`BatchGetBuilds` on the project, `ecs:CreateExpressGatewayService`
   +`DescribeExpressGatewayService` (fence by the `Service=mf-delivery` tag where possible),
   `iam:PassRole` on the two Express roles + the CodeBuild role, and S3 put on the source prefix. Set
   the job env from these. Remove the App Runner role/permissions/`APPRUNNER_*` env/`config.appRunner`.
   `cdk synth` must stay green for dev + live.
6. **Tests**: control-flow unit tests with fakes for `ecsExpress` (build → create → extract endpoint;
   build failure fails the step; abort mid-poll rejects) and `imageBuild` (start → poll → uri; failed
   build; abort). Update the delivery/deliver tests that referenced App Runner. The offline e2e uses
   the FAKE delivery clients, so it must stay green unchanged.
7. Update PLAN.md M5 deploy box + `docs/backlog/README.md`/TODO-EXTERNAL wording (App Runner → Express).

## Do NOT
Deploy (the main session deploys after review). Live-call AWS from tests. Remove the `deploy.deployFromRepo`
seam name (keep it — `deliver.ts` calls it). Touch the gates or orchestrator.

## Verify
`npm run lint`, `npm test`, `npm run e2e`, `npm run build`, `cd infra && npx cdk synth`. Report: what
was built, what stays live-unverified (the real Express/CodeBuild API calls) and why, and the exact
infra a deploy will create.
