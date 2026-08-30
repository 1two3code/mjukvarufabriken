# Stream: test-and-replay — expand the offline e2e + record/replay cassette

Areas: `packages/harness/test/*`, `packages/harness/src/spec/specEngine.ts`, a new
`packages/harness/src/testing/` (record/replay client), `apps/job/src/*` (a `--record` seam only),
`docs/TESTING.md`, root `package.json` scripts. Do NOT touch api/portal/site/infra or the harness
job logic itself beyond wiring the record seam.

## Context
`packages/harness/test/job/e2e.offline.test.ts` (built 2026-08-27) runs the real `runJob` with the
two model seams faked: a fake `SpecEngineClient` (planner) and `vi.mock('@anthropic-ai/claude-agent-sdk')`
for worker + gate `query()` sessions, seeded from `templates/web`. `npm run e2e` = ~45 s, 0 tokens.
`docs/TESTING.md` describes it.

## Deliverables
1. **Expand the offline e2e** with cases that exercise real code paths not yet covered, each fast:
   - kill switch: the job row flips to `killed` mid-build → the orchestrator aborts all sessions and
     ends `killed` with no delivery (drive `hooks`/the kill poll seam).
   - budget abort: a tiny `maxTokens` → first breach aborts, job `failed` reason `budget exceeded`.
   - two-uid sandbox: run one case with `WORKER_UID`/`WORKER_GID` set to the current uid+gid via the
     `sandboxUser` seam so the setpriv/`launch` branch is exercised without needing root (assert the
     command wrapping, not a real uid switch — that stays in exec.test.ts).
   - delivery failure → debug bundle: a gate fails closed → assert `apps/job`'s debug-bundle upload
     fired (fake store holds `deliverables/<id>/debug/repo.zip` + reports).
   - App Runner deploy step: assert the dry-run deploy client produced a deployUrl and the repo+bundle
     are still the contract (`ok`) when deploy is faked.
2. **Record/replay cassette** (`packages/harness/src/testing/cassette.ts`): a `SpecEngineClient`
   wrapper and a `query()` wrapper that, in `record` mode, pass through to the real
   client/SDK and append each request+response to a JSONL cassette file; in `replay` mode, match the
   next request (by role/system-prompt hash, order-preserving) and return the recorded response with
   zero network. Deterministic; no `Date.now()`/random in the matcher.
3. Wire a `--record <dir>` / `MF_CASSETTE=<dir>` seam into `apps/job` (and/or a
   `packages/harness/scripts/record-run.ts`) so ONE real run writes a cassette, and an offline
   `npm run e2e:replay -- <dir>` replays it through the real `runJob` with no tokens. Keep it behind
   the flag so normal runs are unaffected.
4. Unit tests for the cassette (record appends, replay matches in order, a missing/extra request is a
   clear error), and an e2e that runs `runJob` against a small committed cassette fixture.
5. Update `docs/TESTING.md` with the replay flow.

## Verify
`npm run lint`, `npm test` (e2e + new tests green, still < ~90 s total), `npm run build`. Commit in
conventional commits. No deploy, no live model calls in tests.
