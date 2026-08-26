# Stream: m8-resident — resident agent mode (PLAN.md M8)

Areas: `packages/resident` (new workspace `@mf/resident`), `infra/resident/` (a separate CDK app
that is deployed INTO the customer's AWS account — not part of `resources-<env>`/`mf-<env>`),
`docs/RESIDENT.md`. Do not touch harness/job/api/portal beyond registering the workspace.

## Context
Decisions: resident agent v1 runs in the customer's own AWS account on the customer's own
Anthropic key; monthly token cap, pause button, audit log of every action; metering → Stripe
usage-based billing (× 1.5 + monthly fee) — billing integration itself is m6-orders' provider
interface, this stream only produces the metering records.

## Deliverables
1. `@mf/resident`: a long-running agent service (Fastify, same conventions as the api) that
   watches a GitHub repo (issues labelled `resident`, or a `/tasks` endpoint) and runs
   `@mf/harness` build tasks against it inside its own container, using the same worker/gate code
   paths (import from `@mf/harness`; do not fork). Hard monthly token cap (`RESIDENT_MONTHLY_TOKENS`),
   a `paused` flag (endpoint + env), and an **audit log**: every action (task started, file
   changed, command run, tokens, PR opened) appended as JSON lines to an S3 object per day and
   exposed via `GET /audit?day=`.
2. Metering: a daily usage record (tokens by model, tasks, cost estimate at list price × 1.5)
   written to S3 and POSTed to the factory api (`POST /internal/resident/usage`, bearer token per
   installation — define the route contract in `packages/models`, implement the api side ONLY as
   a stub route that stores the record; m6-orders picks it up for billing).
3. `infra/resident/`: CDK app (own package.json, `npm i --prefix infra/resident`) that a customer
   deploys with `cdk deploy` into their account: ECS Fargate service for the resident, secrets
   for their Anthropic key + GitHub token, S3 bucket for audit/metering, least-privilege role,
   scoped to one repo. `cdk synth` must be green offline.
4. Tests with fakes for cap, pause, audit log shape, metering math.
5. `docs/RESIDENT.md`: what it does, deploy steps, cost model, how to pause/stop.

## Verification
- `npm run lint`, `npm test`, `npm run build`, `cd infra/resident && npx cdk synth`.
- PLAN.md M8 boxes ticked as "code + synth verified; not deployed to a customer account".
