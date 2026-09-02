# Preview resources beyond the database

Captured 2026-08-31 (Hasse + /rc session). Wave 12 provisioned the first preview resource type —
a per-job database on the platform RDS (`docs/DELIVERED-DB.md`). But the env-manifest (wave 7)
*detects* everything an app needs, while only `DATABASE_URL` is *provisioned*. An app whose spec
needs object storage (photo uploads), email, or queues still gets nothing — with the wave-12
acceptance gate, such a delivery now fails closed instead of shipping broken, which is correct
but means the demo can't be delivered at all.

**Urgency: dogfood app #1 (the photo PWA, S-class) needs S3 for photos — this gap is the very
next run, not hypothetical.** Do this before that run, or accept the run will flush it out.

## Design direction (same pattern as the DB)
A small menu of preview resources on shared infra, provisioned per job, scoped per job:
- **S3**: one shared preview bucket; each delivered Express service gets a task role scoped to
  `preview/<jobId>/*` — same self-scoping mechanism wave 11 built for deliverable uploads
  (`sts:AssumeRole` + inline session policy). The app's manifest-detected `S3_BUCKET`/prefix env
  is injected like `DATABASE_URL` is.
- **Email**: `log` transport at preview stage (same as our own dev); real email is a paid-stage
  concern.
- **Everything exotic** (Fortnox, SMS, third-party APIs): stubbed at preview; real integrations
  belong to the paid stage in the customer's vended account (M11).
- Teardown: preview prefix + DB dropped together with the existing deployed_services teardown
  path (same open item as the wave-12 DB note). **Done, wave 14 (hosting window):**
  `previewStorageService.teardown(jobId)` deletes every object under `preview/<token>/` and the
  `mf-preview-app-<token>` role (inline policy first; `NoSuchEntity` = already gone) and
  `previewDbService.teardown(jobId)` drops the database + role, both from
  `accountService.runLifecycleAction('teardown')` after the fenced deprovision succeeds. A final
  export (`exportService.finalExport`: `repo.zip`, `database.json`, `storage/*` +
  `storage-manifest.json`, then `DELETION-CERTIFICATE.md` at completion) is taken first — a
  confirmed teardown is refused until it is `done` unless an admin passes `skipExport`. The api's
  own bucket grants are now prefix-fenced (`deliverables/*` Get/Put, `preview/*` Get/Delete).
  Gated on `ORG_LIFECYCLE_ENABLED` like the deprovision (off → `skipped`, nothing deleted).

## Non-goals
No per-preview CDK stacks (cost/speed/blast-radius — see the preview-vs-paid split rationale in
the strategy discussion 2026-08-31); no real third-party integrations at preview stage.
