# C1 — hard egress fence (groundwork, flag off)

Status 2026-08-31: **built synth-only behind `jobs.egressFence`, DEFAULT OFF** (wave12/gate-b).
Nothing is deployed; dev synth is unchanged with the flag off (pinned by
`infra/test/egress-fence.test.ts`). This documents what the flag builds and what flipping it
requires.

## Why

Finding C1 (3-platform-security.md): the egress allowlist is a convention, not a fence. The
tinyproxy sidecar shares the job task's ENI, so the job SG cannot tell proxy traffic from a
worker that runs `curl --noproxy '*'` — the SG allows 443/80 to anywhere and the allowlist is
only honored by processes that respect `HTTPS_PROXY`. A prompt-injected worker reaches any host
on the internet.

## What the flag builds (`jobs.egressFence: true`, resources-stack.ts + web-stack.ts)

- **Proxy in its own task/SG**: the tinyproxy image runs as a standalone Fargate service
  (`mf-egress-proxy-<env>`, desiredCount 1) on the jobs cluster, reachable at
  `egress-proxy.mf-<env>.internal:8888` (Cloud Map private DNS namespace on the cluster). Its SG
  is the only one with internet egress (443/80 anywhere); ingress only from the job SG on 8888.
- **Deny-by-default job SG**: the 443/80-to-anywhere rules are NOT created. Instead, exactly:
  - proxy SG on 8888 — the single internet route (allowlist enforced by tinyproxy's
    FilterDefaultDeny, `apps/job/proxy/filter`)
  - VPC interface-endpoints SG on 443 — the direct-to-AWS `NO_PROXY` set
  - the S3 managed prefix list on 443 (`jobs.s3PrefixListId`)
- **Job→api reports ride the proxy** (token claim, status events, kill-switch polling — the
  job's whole `JOB_API_URL` surface). An SG-to-SG egress rule to the ALB's SG **cannot** carry
  this traffic and is deliberately not created: SG-referenced rules only match packets addressed
  to the referenced group's ENI *private* IPs, while the api host (`api.<env>.…` or the ALB DNS
  name) resolves to the internet-facing ALB's *public* IPs — such a rule would be dead weight
  and every fenced job would die at its startup token claim. Instead, with the fence on:
  - web-stack leaves the api host **out of `JOB_NO_PROXY`**, so the job's fetches to the api go
    through `HTTPS_PROXY` like all other internet traffic (route: job SG → proxy SG → NAT →
    public ALB, TLS end-to-end via CONNECT);
  - resources-stack sets `FILTER_ALLOW_EXTRA=<apiDomainName>` on the proxy service and the
    image's entrypoint (`apps/job/proxy/entrypoint.sh`) appends it to the tinyproxy allowlist.
  - **Consequence: the fence requires `environment.domain`** — synth fails loudly without it
    (the ALB's generated DNS name lives in mf-<env>, which resources-stack cannot reference).
- **VPC endpoints** (these carry an hourly cost, ~7 × ≈7 USD/month + data): interface endpoints
  for Secrets Manager, STS, ECS, CodeBuild (the job's NO_PROXY calls) plus CloudWatch Logs,
  ECR api and ECR dkr (what Fargate itself needs to pull the job image and write logs once the
  SG stops allowing 443-anywhere), and an S3 gateway endpoint (artifact uploads + ECR image
  layers, which live in S3).
- **Job task**: no proxy sidecar/dependency; `HTTP(S)_PROXY` points at the proxy service DNS.

## Flipping the flag on a real environment

1. `MF_EGRESS_FENCE=1` plus `MF_S3_PREFIX_LIST_ID=pl-…` in the deploy environment
   (`infra/.env.<env>` / the GitHub environment), or set `egressFence`/`s3PrefixListId` in
   `infra/lib/config.ts`. The prefix list id is per region:
   `aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.eu-north-1.s3`.
2. The environment must have `domain` configured (see above — synth refuses otherwise). Deploy
   `resources-<env>` then `mf-<env>`. Both must run with the flag set — a mixed deploy leaves
   the job SG deny-by-default while the api still hands jobs a `JOB_NO_PROXY` containing the
   api host, so jobs bypass the proxy for the api and fail to report (they fail loudly at the
   startup token claim; no silent loss). Note the api tasks only pick up the new `JOB_NO_PROXY`
   when the `mf-<env>` deploy cycles them, and the proxy service must be up (with
   `FILTER_ALLOW_EXTRA` set) before any fenced job runs.
3. **Verify with a canary job before trusting it**: a full build exercises the api report path
   (token claim → status events → kill-switch poll) and npm/GitHub/Anthropic through the proxy,
   Secrets Manager/STS/ECS/CodeBuild through the endpoints, S3 uploads, image pull and logs.
   The endpoint set was derived from `jobNoProxyHosts` + Fargate's own needs, synth-only — a
   missed dependency shows up here as a hang/timeout in that phase.
4. Expect the first fenced deploy to REPLACE nothing: the job SG keeps its logical id and
   description (mf-<env> imports it); only its rules change.

## Known gaps / follow-ups (not blockers for the flip)

- **The NAT still exists** and the proxy uses it; the fence narrows *who* can reach it to the
  proxy SG. The ops NAT-bytes alarm stays meaningful.
- **tinyproxy CONNECT allowlist is still the content filter** — the fence makes it
  unbypassable, it does not make it stricter. Domain list: `apps/job/proxy/filter`.
- **One shared proxy for all concurrent jobs**: scale `desiredCount` (or per-AZ) before raising
  job concurrency; `minHealthyPercent: 0` means a proxy redeploy can briefly interrupt
  in-flight fetches (npm/git retry; an Agent SDK call surfaces as a retryable API error). With
  the fence on this now includes the job→api report path — the reporter's own retries cover a
  brief blip, but the proxy is a single point of failure for status/kill-switch traffic too.
- **The per-job report token transits the proxy** as a CONNECT tunnel: TLS is end-to-end to the
  ALB (the fence requires `domain`, so the api terminates real HTTPS) — tinyproxy sees the
  hostname, never the token.
- **The resident (C2) has no fence at all** — same design should be applied to
  `infra/resident` when it is next touched.
- IMDSv2 hop-limit hardening from the audit is EC2-shaped; Fargate tasks expose the task
  metadata/credentials endpoints (169.254.170.2), which remain in NO_PROXY and are unaffected
  by the SG (link-local). Stripping AWS_* env from the sandbox (done, exec.ts) remains the
  control there.
