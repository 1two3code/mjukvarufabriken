# @mf/harness

Skeleton of the build-job orchestrator. `runJob(spec, budget)` is a typed placeholder; `JobSpec`, `JobBudget`, `JobStatus` and `JobResult` are the contract the api and the job container will share.

M3 intent: a job runs as a container on ECS Fargate, receives a frozen spec + budget (never customer secrets), plans a task DAG, runs Claude Agent SDK workers in parallel git worktrees, merges, and streams progress events to `job_events` in `@mf/db`. Hard token budget, kill switch, egress allowlist (npm, github, anthropic).

No runtime dependencies yet — `@anthropic-ai/claude-agent-sdk` is added when M3 starts.
