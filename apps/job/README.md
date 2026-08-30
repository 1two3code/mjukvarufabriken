# @mf/job — build-job container

One container = one job. The entrypoint (`src/index.ts`) reads `JOB_ID`, loads the job and its frozen spec through a `JobReporter` (`src/reporter.ts`), seeds `/work/repo` from the golden template baked into the image (`templates/web`, `git init`, one commit), then runs the `@mf/harness` orchestrator and streams status, `tokens_used` and events back through the same reporter. Two implementations, one code path:

| Reporter | Selected by | Used |
|---|---|---|
| `api` | `API_URL` + `JOB_TOKEN` (the api's `ecs:RunTask` container override) | Fargate. First call is `POST /internal/jobs/:id/token`: the bootstrap token from the override is exchanged for a fresh one only the job process holds (the override is visible in the task environment — `/proc/*/environ` from any worker shell — in `ecs:DescribeTasks` and in CloudTrail, so it is dead before the first worker starts). Then `GET /internal/jobs/:id` (spec, budget, waivers, kill flag), `POST /internal/jobs/:id/events` (batch, every event numbered `seq` so a retried batch is stored once) and `PATCH /internal/jobs/:id` (status/tokens/plan/gates/urls; status only moves forward, a terminal status or an admin kill revokes the token). Bearer = a random 32-byte per-job token whose sha256 is on the row (`jobs.report_token_hash`); it can reach nothing but its own active job. Retries 5xx/network errors, gives up on 4xx (a 404 on a write is an error, not a dropped event), truncates `reason` to 20 000 chars, sends events strictly in order |
| `db` | `DATABASE_URL` | `npm run job:dev` and the docker compose `job` profile against the local Postgres |

The container never holds a database credential on Fargate (docs/M3-REVIEW.md #18): no `DATABASE_SECRET_ARN`, no secret grant, no 5432 security-group rule. The api forwards `notify` events to `AUTH_ADMIN_EMAILS` and appends `gate` reports to `jobs.gates` on ingestion.

```
plan (Anthropic SDK, PLAN_MODEL)          → job_events: planned {plan}
  └─ ready tasks × maxWorkers in parallel  → task_started / task_finished / task_failed
       each: clone → branch task/<id> → Agent SDK query() → npm run lint + npm test → commit → fetch
  └─ merge each finished branch into main  → merge {ok}
       (one repair session on conflict, fail closed otherwise)
  └─ QA gates on main (M4), fail closed, each → gate {GateReport}
       verify (lint + test) → acceptance-tests → review → acceptance-check
  └─ done | failed | killed (+ notify {to: 'admins', subject, text} on anything but done)
```

## QA gates (M4)

After the last merge `@mf/harness` `runGates` runs four gates in order; the first red one ends the job with status `failed` and a reason listing it. Every gate emits a `gate` event whose payload is a `GateReport` (`name, ok, startedAt, durationMs, tokens, summary, details`), counts toward the token budget and honours the abort signal (budget / wall clock / kill) like a task.

| Gate | Session(s) | Passes when |
|---|---|---|
| `verify` | none | `npm run lint` + `npm test` green on main |
| `acceptance-tests` | 1 writer (full tools) + at most 1 fix on app code | one `<id>.test.ts[x]` per criterion (`apps/app/src/acceptance/` or `apps/api/test/acceptance/`) exists and lint + test are green. The fix session may not touch the tests — they are restored from the test commit afterwards |
| `review` | 1 read-only reviewer (structured `ReviewFinding[]`) + at most 1 fix + 1 re-review | no unwaived **high** finding open after the fix; medium/low are recorded in `details`. Finding ids are `<file>:<line>`; `jobs.gate_waivers` lists ids an admin has waived |
| `acceptance-check` | 1 read-only session (structured `AcceptanceReport`) | every criterion id is `met` with evidence (test file + what it asserts) |

On `failed`/`killed` the orchestrator also emits a `notify` event (`{ to: 'admins', subject, text }`); the api mails it to the admins when it ingests the event (`jobService.reportEvents`) and appends every `gate` payload to `jobs.gates` (migration `0005_jobs_gates.sql`); the final PATCH stores the full list again.

### Running only the gates on a built repo

```
npm run gates:demo -- --repo /work/repo --spec spec.json [--seed <commit>] [--waive apps/api/src/x.ts:12]
npm run gates:demo -- --repo /work/repo --job job.json      # { spec, gateWaivers? } e.g. a jobs row
```

Live Agent SDK sessions (needs `ANTHROPIC_API_KEY`, honours `WORKER_MODEL`); prints one report per gate, the JSON reports at the end, exit 0 only when all gates are green. `--seed` is the commit the review diffs against (default: the repo's root commit — the seed commit of a job repo).

## Configuration (env)

| Variable | Purpose |
|---|---|
| `JOB_ID` (or argv) | Job to run — set by the api's `ecs:RunTask` override or `npm run job:dev -- <id>` |
| `API_URL`, `JOB_TOKEN` | Fargate: the api to report to and the per-job **bootstrap** token (RunTask override — never logged by the api, but visible to `ecs:DescribeTasks`/CloudTrail and in `/proc/<pid>/environ`; exchanged for a fresh token before any worker starts, so what leaks is dead) |
| `DATABASE_URL` | Local: report straight to Postgres instead |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_API_KEY_SECRET_ARN` | Model access for planner + workers |
| `GITHUB_TOKEN` / `GITHUB_TOKEN_SECRET_ARN` | M5: create + push the customer repo (`GITHUB_ORG`, default `mjukvaruhuset`); missing → the `repo` delivery step fails closed |
| `ECR_REPOSITORY_URI`, `CODEBUILD_PROJECT`, `EXPRESS_EXECUTION_ROLE_ARN`, `EXPRESS_INFRASTRUCTURE_ROLE_ARN`, `ECS_CLUSTER` | M5: ECS Express preview of the customer api — CodeBuild builds + pushes the image to ECR, then `CreateExpressGatewayService`; any missing → `deployUrl: null` + notify |
| `ARTIFACTS_BUCKET` | M5: bundle (`deliverables/<jobId>/`) + SPA build destination |
| `ARTIFACTS_ROLE_ARN` | M3 hardening #1: role the job assumes (session-policy-scoped to its own `deliverables/<jobId>/*` + `delivery-source/<jobId>.zip`) to upload — the task role itself has no S3 permission |
| `DELIVERY_DRY_RUN=1` | Log the GitHub / ECS Express / S3 calls instead of making them |
| `PLAN_MODEL`, `WORKER_MODEL` | Model overrides (default `claude-sonnet-5`) |
| `WORK_DIR`, `TEMPLATE_DIR` | `/work` and `/usr/src/templates/web` in the image |
| `WORKER_UID`, `WORKER_GID`, `WORKER_HOME` | Second uid for worker sessions and the repo's scripts (image: `1001` / `1001` / `/home/worker`, see "Sandbox uid"); unset or equal to the job's own uid → everything runs as one user, which is what `npm run job:dev` does |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY=1` | Egress through the allowlist sidecar |

No customer secrets are passed in: the container only sees the job id, the report token (or the local database url), the Anthropic key and the GitHub token. The token, the database location and the secret ARNs are dropped from Node's environment before any worker session starts (`@mf/harness` `sandboxEnv` also strips `DATABASE_*`, `*_SECRET_ARN`, every `AWS_*`, `ECS_*`, `EXPRESS_*`, `CODEBUILD_*` and `ECR_*` key — the task-role credential endpoint included; `packages/harness/test/job/exec.test.ts` sweeps the full list), so the agent's shell only inherits the Anthropic key and the proxy settings. That scrub does not reach the kernel's copy (`/proc/<pid>/environ` of the node process) — which is why the api reporter exchanges the bootstrap token first thing (`claim`), the api revokes the token on the job's terminal write and on an admin kill, and the worker sessions run under a second uid (below) that cannot read the job process's `/proc` entries or memory at all. The GitHub token is read once at start-up and removed from the environment before any session starts (it only reaches the Octokit client and the one `git push` argument list). The task role can read the Anthropic key and GitHub token secrets, `sts:AssumeRole` into `ARTIFACTS_ROLE_ARN` (never `s3:*` directly), start the one delivery CodeBuild project and manage `Service=mf-delivery`-tagged ECS Express services — nothing else. The assumed role's own ceiling is `deliverables/*` + `delivery-source/*`; the job narrows it further with an inline session policy built from its own `JOB_ID` before every upload (`packages/harness/src/job/delivery/artifacts.ts`), so one job's credentials can put objects only under its own prefix/key, never another job's (M3 hardening #1). After green gates the job delivers (M5): handover docs committed, repo `mjukvaruhuset/<app>-<job prefix>` pushed, ECS Express preview (image built via CodeBuild → ECR), bundle in S3 — see packages/harness/README.md "Delivery"; `repositoryUrl` on the job row, the `Deliverable` record in the last `delivery` event.

## Sandbox uid

Two unprivileged users in the image (docs/M3-REVIEW.md #18 follow-up): `node` (1000) runs the job process — reporter, git, merges, file plumbing — and `worker` (1001) runs every Agent SDK session (the Claude Code process and every command it spawns) and every command of the customer repo the job itself runs (lint, test, `npm install` after a merge). A model-driven shell is therefore a different uid from the process holding the live report token: `/proc/<job pid>/environ`, `/proc/<job pid>/mem` and `ptrace` are all refused by the kernel, and the ECS credential endpoint (169.254.170.2, in `NO_PROXY` so the proxy never sees it) is unreachable in practice because the per-task `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` never reaches a worker.

How the switch works (documented choice): the container starts as root only for `setpriv` to drop to `node` with `CAP_SETUID`/`CAP_SETGID` (the uid switch) and `CAP_KILL` (signalling the other uid's processes) as **ambient** capabilities and a bounding set cut to those three (`apps/job/Dockerfile` `CMD`). The harness (`@mf/harness` `launch` in `exec.ts`) spawns every child through `setpriv --inh-caps=-all --ambient-caps=-all --no-new-privs`, adding `--reuid=worker --regid=worker --init-groups` for worker sessions and repo scripts — so the capabilities exist in the node process alone; a worker runs with an empty capability set and `no_new_privs`, which also blocks any setuid binary. The Agent SDK session is spawned through its `spawnClaudeCodeProcess` hook with the same wrapper, with `HOME=/home/worker` and its own `CLAUDE_CONFIG_DIR`; its stderr is forwarded to the job log and its tail lands in the session error. Every worker command and session runs in its own process group, killed whole on timeout, abort (budget, kill switch) and when the session's Claude Code process exits — which is what `CAP_KILL` is for (`kill(2)` from `node` to a `worker` process is `EPERM` without it, and every kill path — spawn timeouts, the SDK's SIGTERM/SIGKILL close, the abort — would silently fail while the worker kept running); a refused kill still resolves the command with the error in its output instead of throwing. A process that starts its own session (`setsid`) escapes the group kill — residual, the container dies with the job.

Files are shared through the `work` group instead of chown ping-pong: `/work` is `node:work` with the setgid bit, the job writes with `umask 002`, git runs with `safe.directory=*` (via `GIT_CONFIG_*`), and `shareWithWorker` puts the group write bit on every tree before a worker first runs in it (the template copy and `cp -al` produce stricter modes) — on directories and single-link files only: the hard-linked `node_modules` share their inodes with the image's template and every other worktree, so those stay read-only (a worker can replace a file in its own tree, not rewrite the inode every later gate executes). The main repo's `.git` is the exception to the sharing (`protectGitDir`): group `node`, no group write bit, world-readable. Git executes what repo config names (`core.fsmonitor`, merge/diff drivers, `url.<base>.insteadOf`, `core.sshCommand`, …) and the job runs `git merge`/`diff`/`commit`/`push` as `node`, so a writable `.git/config` — or a writable `.git` directory, since git renames lock files into place — would be a way back to the job uid, and writable refs a way past the gates. Consequences: a task does not get a linked `git worktree` but a full clone (`git clone --no-hardlinks`, `.git` included, all the worker's), and after the gate the job fetches `task/<id>` from it with `git upload-pack` running as the worker (`--upload-pack`, `fetch.fsckObjects`) — the trust model of any remote; sessions that run in the main repo (acceptance tests, review fixes, merge repair) read git freely but cannot commit — their prompts say so and the harness commits what they leave. `WORKER_UID` unset (or equal to the job's uid) keeps the single-user behaviour, so `npm run job:dev` and the tests need nothing.

Manual check (the uid switch cannot be exercised in unit tests, `docker compose --profile job build` first). It runs the exact privilege chain of the image — root → `node` with ambient caps → worker — and prints what a worker session can and cannot do, and that the job can kill a worker process:

```
docker compose --profile job run --rm job setpriv --reuid=node --regid=node --init-groups \
  --bounding-set=-all,+setuid,+setgid,+kill --inh-caps=+setuid,+setgid,+kill --ambient-caps=+setuid,+setgid,+kill \
  node -e "
const { spawn, spawnSync } = require('node:child_process')
const run = (args, label) => console.log(label, spawnSync('setpriv', args, { encoding: 'utf8' }).stdout.trim())
const worker = ['--reuid=1001', '--regid=1001', '--init-groups', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--']
run([...worker, 'sh', '-c',
  'id; cat /proc/' + process.pid + '/environ >/dev/null 2>&1 && echo ENVIRON-READABLE || echo environ: permission denied;' +
  'setpriv --reuid=0 -- id >/dev/null 2>&1 && echo ESCALATED || echo escalation: refused;' +
  'grep -E \"^(CapEff|NoNewPrivs)\" /proc/self/status; touch /work/probe && echo /work: writable'], 'worker →')
run(['--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs', '--', 'sh', '-c', 'id; grep CapAmb /proc/self/status'], 'job child →')
const sleeper = spawn('setpriv', [...worker, 'sh', '-c', 'sleep 30 & sleep 30'], { detached: true })
setTimeout(() => { try { process.kill(-sleeper.pid, 'SIGKILL'); console.log('kill worker group → ok') } catch (e) { console.log('kill worker group →', e.code) } }, 300)
sleeper.on('exit', (code, signal) => console.log('worker group exited:', signal))
"
```

Expected: the worker line shows `uid=1001(worker) … groups=1001(worker),1002(work)`, `environ: permission denied`, `escalation: refused`, `CapEff: 0000000000000000`, `NoNewPrivs: 1`, `/work: writable`; the job child shows `uid=1000(node)` with `CapAmb: 0000000000000000`; then `kill worker group → ok` and `worker group exited: SIGKILL` (without `+kill` in the three capability lists the kill line reads `EPERM` and the command hangs for 30 s). Verified 2026-08-27 against the image built from this Dockerfile. To check a real run instead, start a job (`JOB_ID=<id> docker compose --profile job run --name job-check job`) and from another shell `docker exec -u worker job-check cat /proc/1/environ` (permission denied) versus `docker exec -u node job-check cat /proc/1/environ` (the job's own env, as the job's uid).

## Budget, kill switch, egress

- **Budget**: every planner/worker/merge message's usage is summed in one `BudgetTracker`; crossing `budget.maxTokens` (or `maxDurationMinutes`) aborts every in-flight session via a shared `AbortController` and the job ends `failed` with reason `budget exceeded`. `tokens_used` is persisted after every task and merge.
- **Kill switch**: `POST /bff/admin/jobs/:jobId/kill` sets `jobs.status = 'killed'` and calls `ecs:StopTask` when a task ARN is stored. The orchestrator also polls `GET /internal/jobs/:id` (`killed`) every 10 s and aborts itself, so a kill works even if StopTask lags; a status PATCH answered with `killed: true` short-circuits the next poll.
- **Egress allowlist**: `proxy/` builds a tinyproxy sidecar (`FilterDefaultDeny`, see `proxy/filter`: npm, GitHub, Anthropic). On Fargate it runs in the same task; the job container gets `HTTP_PROXY`/`HTTPS_PROXY` pointing at `localhost:8888`, `NO_PROXY` for the ECS credential endpoint, Secrets Manager, the artifacts bucket and the api host (the api appends its own host via the RunTask override, `JOB_NO_PROXY`), and the job security group allows only 443/80 out — no database rule. Note: Fargate sidecars share the task ENI, so the security group cannot distinguish proxy traffic from a process that ignores `HTTPS_PROXY`; a hard network fence needs a proxy in its own task/SG (see TODO-EXTERNAL.md). Locally, docker compose puts the job on an `internal` network where only the proxy has internet, which *is* a hard fence — that is where the allowlist is verified.

## Local runs

```
docker compose up -d                          # Postgres 17 on :5432
npm run db:migrate                            # apply packages/db/migrations
npm run db:seed                               # queued demo job, prints <id>
npm run job:dev -- <id>                       # run it here (uses root .env: ANTHROPIC_API_KEY, DATABASE_URL)

docker compose --profile job build            # job + egress-proxy images
JOB_ID=<id> docker compose --profile job run --rm job   # same job, behind the proxy
```

The api's `GET /bff/jobs/:id` and `GET /bff/jobs/:id/events?after=<id>` read the same tables, and the portal page `/orders/:orderId/job` polls them.
