# Audit 2026-08-31 — follow-ups deliberately NOT done in wave 13

Wave 13 (`wave13/infra-security`) fixed the three infra findings that survived independent triage of
the external audit: P0-1 (unscoped `grantRead` on the delivery CodeBuild role), P0-5 (a live deploy
without a `domain` degrading silently to plain HTTP), P1-8 (missing `permissions` in `ci.yml`).

Triage endorsed each of the items below but rated them backlog, not day-1. They are recorded here so
the reasoning is not re-derived from scratch next time.

## 1. `codebuild:StartBuild` is unfenceable at the IAM layer (from P0-1)

Deleting the unscoped grant closes the read path, but the structural problem stays: the job task role
holds `codebuild:StartBuild` on the delivery project (`resources-stack.ts`) plus `iam:PassRole` on its
service role, and `StartBuild` has **no** IAM condition key for `buildspecOverride`. Holding it is
arbitrary execution as that role, in a `privileged: true` container, over an AI-authored repo whose
`Dockerfile` is not in `isProtectedTestPath` (`gateSessions.ts`).

The repo already solved the identical problem for the database: the job never gets credentials, it
calls the api's `/internal/jobs/:id` with its per-job token. **Fix: move the image-build kickoff to
that same trusted endpoint**, which removes `StartBuild` *and* `PassRole` from the job task role
entirely. A real refactor across `apps/api`, `packages/harness/src/job/delivery` and `infra`.

Cheaper companion, worth doing whenever that area is next open: put `delivery-source/` in **its own
bucket**, separate from the one holding `deliverables/<jobId>/` for every job, so a future unscoped
grant cannot reach another tenant's deliverables at all.

Explicitly rejected: `vpcConfig` on the build project. It forces the privileged build down the NAT
path (cost + latency) and does not remove the core problem.

## 2. Gate the security scanners on a baseline (from P1-8)

`ci.yml`'s `npm audit` step and both Trivy image scans carry `continue-on-error: true`, so neither can
fail a merge — the Trivy steps even set `exit-code: '1'`, which `continue-on-error` then discards.
That is a **documented, deliberate** position (the comments in `ci.yml` say so), not an oversight: the
alternative today is blocking every PR on transitive advisories nobody can fix.

The right design is to fail on **new** HIGH/CRITICAL relative to a checked-in baseline (`.trivyignore`
plus an `npm audit` allowlist), not on any finding. That is roughly a day of work plus ongoing
baseline maintenance, and its value is low while there are no untrusted contributors and Dependabot
already opens the PRs. Done in wave 13 instead: the honesty fix — PLAN.md now says the scanners
cannot fail a merge, so a green CI check is not read as a passing scan.

Explicitly rejected: blanket `--ignore-scripts` on the seven `npm ci` calls. This tree depends on
esbuild and lightningcss, whose install steps place platform binaries; a wholesale `--ignore-scripts`
is a plausible way to break CI in a way that looks like a flake. Per-prefix and verified, or not at
all.

## 3. Give `live` a real `domain` block (from P0-5)

`infra/lib/deploy-guard.ts` makes a domain-less live deploy fail closed, at synth and in both deploy
paths. That is the interim, not the destination: the resolution is a `domain` block for `live` with
`fromEnv(...)` + `PENDING-LIVE-*` fallbacks exactly like `qa`'s, which removes the HTTP path instead
of refusing it (and, like qa's, makes an unconfigured deploy fail closed at CloudFront/ALB on the
unknown ARN). Blocked on the live ACM certificates — tracked in TODO-EXTERNAL.md.
