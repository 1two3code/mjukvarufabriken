# infra

AWS CDK app for mjukvaruhuset.se. It is **not** an npm workspace (CDK's Docker asset bundling and `npx` inline scripts behave better without hoisted `node_modules`), so install and run it separately:

```shell
npm i --prefix infra
npm run build                    # the web stack uploads apps/site/dist/<env> and apps/portal/dist/<env>
cd infra && npx cdk synth
```

## Stacks (per environment in `lib/config.ts`)

| Stack | Contents |
|---|---|
| `resources-<env>` | VPC (2 AZs, 1 NAT), DynamoDB `items` table (+ `status` GSI), private encrypted attachments bucket, optional OpenSearch domain (`enableOpenSearch`). Exports `vpc-id`, `dynamo-items`, `s3-attachments`, `opensearch-endpoint`. |
| `mf-<env>` | **Site + Portal**: one private S3 bucket + CloudFront each (OAC, SPA fallback, security headers). **API**: ECS Fargate behind an ALB from `apps/api/Dockerfile`, health check `/health`, task role granted access to the resources above, env vars `ITEMS_TABLE`, `ATTACHMENTS_BUCKET`, `OPENSEARCH_ENDPOINT`. Optional custom domains + Route 53 records. |

Nothing pre-existing is required in the account except a CDK bootstrap (`npx cdk bootstrap aws://<account>/<region>`).

## Custom domains (optional)

Set `domain` on an environment: two ACM certificates you issue up front (the CloudFront one **in us-east-1**, the API one in the stack region) and the Route 53 hosted zone id/name. Without `domain`, the app is served from the CloudFront default hostname and the API on the ALB DNS name over HTTP.

## First deploy

```shell
export CDK_DEFAULT_ACCOUNT=<account> CDK_DEFAULT_REGION=<region>
npm run build
cd infra && npx cdk bootstrap && npx cdk deploy resources-dev mf-dev
```

Then point `VITE_API_URL` in `apps/portal/.env.dev` (and `apps/site/.env.dev`) at the `ApiUrl` output and redeploy `mf-dev`. The GitHub Actions `deploy` workflow automates this (see `.github/workflows/deploy.yml`).
