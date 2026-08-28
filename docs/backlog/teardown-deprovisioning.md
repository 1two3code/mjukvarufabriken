# Backlog brief: teardown & deprovisioning policy

Direction from Hasse 2026-08-28. We can *provision* (repo → CodeBuild → ECR → ECS Express, and
soon a vended AWS account per customer) but there is **no orderly way to tear it down**. Every
teardown so far has been ad-hoc — and it bit us: the App Runner/Express teardowns this session hit
CLI-too-old errors, `delete-express-gateway` ARN-format mismatches, and a create that was "not
idempotent" because a half-deleted service lingered. A real business needs a deliberate,
idempotent, audited deprovisioning path for **broken contracts, non-payment, failed ventures,
customer churn, and graduation.**

## When a teardown is triggered
- **Contract ended / customer left** — orderly wind-down with a grace period.
- **Non-payment** — suspend compute fast (stop the bleed), retain data through a grace window,
  then deprovision if unresolved.
- **Failed venture / abandoned build** — the customer never went live; clean up the scaffolding.
- **Customer request** ("delete my stuff") — honour it, with an export first.
- **Graduation** — the customer takes the account out of our org (`MoveAccount`); we stop operating
  it but delete nothing (see [org-accounts.md](org-accounts.md)).

## The policy dimensions to decide
1. **Suspend before delete.** A reversible **suspended** state — compute off (ECS desiredCount 0 /
   service deleted), data + repo retained — is the default first step. Permanent teardown is a
   separate, deliberate action after a grace period. Non-payment → suspend, not delete.
2. **Grace period + notifications.** N days between suspend and permanent teardown, with warnings.
   The customer owns their code and data; deletion is last, not first.
3. **Data & code handover first.** Before any delete: the repo is already theirs (GitHub); export
   any app data (the in-memory store is ephemeral, but real customers will have a DB); hand over a
   final bundle. Never delete what the customer hasn't been given.
4. **Soft-delete vs hard-delete.** Tag + quarantine (soft) for the grace window; hard-delete only
   after it and only for what we own. The vended AWS account is *closed* deliberately (90-day AWS
   window), never automated.
5. **Cost-stop is immediate, data-delete is delayed.** On any trigger, stop paying for compute now;
   keep cheap storage (S3/ECR/repo) through the grace window.

## What has to be torn down (the inventory)
Per customer/delivery: ECS Express service(s) (dev/qa/live), the ECR image(s), the per-job
CodeBuild source zips (`delivery-source/*`) and S3 deliverables, the GitHub repo (transfer to the
customer, don't delete), Route 53 records, secrets (Stripe, GitHub-app scoping, VAPID/JWT the app
generated), the metering/billing records (stop metering on suspend), and — at the top — the
**vended AWS account** (suspend = stop operating; close = deliberate manual). Everything the
delivery creates is already tagged `Service=mf-delivery` — use that for discovery/fencing.

## Build (deliverables)
1. **`deprovision(target, mode)` module** (likely in `@mf/org` or a `packages/lifecycle`):
   `mode = suspend | resume | teardown`, idempotent, **dry-run by default**, with an **audit log**
   of every resource touched. Discovers resources by tag, not by a stored list (self-healing if the
   record drifts). Handles the "already gone" and "half-deleted" cases the manual teardown tripped
   on.
2. **Lifecycle state on the customer/order** (`active | suspended | torn_down`) driving it, wired to
   the payment state machine (non-payment → suspend) and an admin action.
3. **Fix the delivery-side reliability** the manual teardown exposed: idempotent Express
   create/delete (deterministic clientToken; treat "not idempotent"/"not found" as success), and a
   working delete path that doesn't depend on a too-old CLI (use the SDK).
4. **Grace-period scheduler** (a job/cron that promotes `suspended` → `torn_down` after N days,
   with notifications) — reuses the M9 liveness-sweep machinery.
5. Tests against mocked AWS/GitHub; a real end-to-end suspend→resume→teardown done once, manually.

## Relation to the rest
- **Provisioning counterpart:** this is the inverse of [org-accounts.md](org-accounts.md) (vend) and
  M5 delivery (deploy). Build them as a pair — every provision path needs its deprovision path.
- **M11 environments** ([environments.md](environments.md)): three envs per customer means three
  times the teardown surface; suspend/resume is also how idle dev/qa scale to zero for cost.
- **Billing:** suspend stops metering; teardown closes it out. Ties to wave-7 stream 6 (cost).

## Verify
`npm run lint`, `npm test` (deprovision against mocked clients: suspend, resume, teardown, already-gone,
half-deleted). One real suspend→resume→teardown of a throwaway delivery, manually, with Hasse.
