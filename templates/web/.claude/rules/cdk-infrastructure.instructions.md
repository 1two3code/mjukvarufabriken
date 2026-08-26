---
description: "Use when writing or modifying AWS CDK infrastructure code under infra/. Covers stack layout, environment config, S3 + CloudFront SPA hosting, ECS Fargate API, and cross-stack references."
applyTo: "infra/**/*.ts"
paths:
  - "infra/**/*.ts"
---

# CDK Infrastructure Conventions

`infra/` is a standalone CDK app (own `package.json`, **not** an npm workspace). Install with `npm i --prefix infra` and synth with `npx cdk synth` from inside `infra/`.

## Layout

- `bin/app.ts` — CDK entry point; iterates over `config.environments` and instantiates one set of stacks per environment.
- `lib/config.ts` — `EnvironmentConfig` (`name`, `account`, `region`, `domain`) and the `config` object. Never hard-code account numbers in stacks.
- `lib/*-stack.ts` — one file per stack, `PascalCaseStack` class, named export.

## Stack naming

`<service>-<environment>` (e.g. `web-dev`, `web-live`). Tag every stack with `Service` and `Environment` via `Tags.of(stack).add(...)`.

## Hosting

- **App**: S3 bucket (private, `BlockPublicAccess.BLOCK_ALL`) fronted by CloudFront with an Origin Access Control, SPA fallback (403/404 → `/index.html` 200) and a `ResponseHeadersPolicy` with strict security headers. Deploy the built bundle with `BucketDeployment` from `apps/app/dist/<mode>`.
- **API**: `ApplicationLoadBalancedFargateService` from `aws-cdk-lib/aws-ecs-patterns`, image built from `apps/api/Dockerfile` with the repository root as build context. Health check path is `/health`. Pass configuration as container `environment` variables that match the `secrets` plugin.

## Cross-stack references

- **Producer**: `new CfnOutput(this, 'Name', { value, exportName: 'export-name' })`
- **Consumer**: `Fn.importValue('export-name')`

Export names must not contain the environment (`api-url`, not `api-url-dev`) — each environment lives in its own account/stack set.

## Permissions

Grant least-privilege access with the resource's `grant*` helpers (`table.grantReadWriteData(taskRole)`, `bucket.grantRead(...)`) rather than hand-written `PolicyStatement`s where possible.
