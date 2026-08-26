# infra

AWS CDK app for the template. It is **not** an npm workspace (CDK's Docker asset bundling and `npx` inline scripts behave better without hoisted `node_modules`), so install and run it separately:

```shell
npm i --prefix infra
cd infra && npx cdk synth
```

One `WebStack` per environment in `lib/config.ts`:

- **App** — private S3 bucket + CloudFront (OAC, SPA fallback, security headers), deployed from `apps/app/dist/<env>`.
- **API** — ECS Fargate behind an Application Load Balancer, image built from `apps/api/Dockerfile` with the repository root as context, health check on `/health`.

Build the app before deploying (`npm run build` at the repository root) so the bucket deployment has something to upload.
