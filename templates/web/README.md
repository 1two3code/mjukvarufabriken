# Web monorepo template

[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](https://www.typescriptlang.org/)

A React 19 + Fastify 5 monorepo template with shared Zod models, RBAC, and AWS CDK infrastructure. See [`CLAUDE.md`](./CLAUDE.md) for the full conventions and architecture.

## Project structure

- [`infra`](infra/README.md): AWS CDK app — `resources-<env>` (VPC, DynamoDB, S3, optional OpenSearch) and `web-<env>` (S3 + CloudFront app, ECS Fargate api). Not part of the workspaces.
- `.github/workflows`: `ci.yml` (lint, test, build, synth on PRs and main) and `deploy.yml` (OIDC deploy to dev, then live with environment approval).
- **apps**
	- [`@template/api`](apps/api/README.md): Fastify BFF.
	- `@template/app`: React SPA (Vite). Ships the "Built by Mjukvaruhuset" caption footer (`src/components/builtBy`); set `VITE_BUILT_BY_URL=` (empty) in `apps/app/.env` to hide it.
- **packages** — shared between the app and the api.
	- [`@template/models`](packages/models/README.md): entity models as Zod schemas with inferred types.
	- [`@template/utils`](packages/utils/README.md): pure utility functions, subpath exports.
	- `@template/access-control`: roles, permissions and permission-check helpers.

## Getting started

Requires Node.js `>=24.14` (see [`.nvmrc`](./.nvmrc)) — TypeScript files are executed directly by Node without a build step.

```shell
npm i
cp apps/api/.env.example apps/api/.env.dev   # then point AUTH_* at your identity provider
npm run start:dev
```

`infra/` has its own dependencies: `npm i --prefix infra`.

## Scripts

- `start:dev`: starts the app (`:5173`) and the api (`:5174`) in dev mode.
- `build`: runs the build script in all workspaces that have it (only the app).
- `test` / `coverage`: runs all tests from the root Vitest configuration.
- `lint`: runs the lint script in all workspaces that have it.
- `version:patch` / `version:minor`: bump the version in all workspaces and the root, without a git tag.
- `upgrade`: update all packages to the latest version allowed by their semver range.
- `clean` / `clean:output`: remove `node_modules`/lock files, respectively build output.

Run a script in one workspace with `-w`: `npm run start:dev -w @template/app` (package name or path — the bare folder name does not resolve).

## Deploying

See [`infra/README.md`](infra/README.md). Short version: bootstrap CDK in the account, configure the `dev`/`live` GitHub environments (`AWS_DEPLOY_ROLE_ARN` secret, `AWS_ACCOUNT_ID`/`AWS_REGION` vars), push to `main`.

## Git hooks

Commit subjects must follow [Conventional Commits](https://www.conventionalcommits.org) (`feat: …`, `fix(scope): …`). `pre-push` runs `lint` and `test`.
