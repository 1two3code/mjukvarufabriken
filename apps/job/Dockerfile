FROM --platform=linux/amd64 node:24-alpine3.22

# git for worktrees/merges, bash + coreutils for the agent's shell tool, ripgrep for Grep,
# setpriv (util-linux) for the uid/capability switch below
RUN apk add --no-cache git bash coreutils ripgrep setpriv

WORKDIR /usr/src

# RDS TLS (M9): @mf/db ships the pinned RDS CA bundle (packages/db/certs) and trusts it for
# the Postgres connection only — no download at build time, nothing added to Node's store.

# Workspace dependencies (same layout as apps/api/Dockerfile) — nothing customer-specific
COPY package*.json ./
COPY tsconfig*.json ./
COPY packages ./packages/
COPY apps/job ./apps/job/
RUN npm i --omit=dev --ignore-scripts

# Two unprivileged uids (docs/M3-REVIEW.md #18 follow-up, wave 5 `sandbox-uid`):
# - `node` (uid 1000) runs the job process: the reporter (holds the live report token), git,
#   the merge, the file plumbing. Its HOME is private (700).
# - `worker` (uid 1001) runs every Agent SDK session and every command of the customer repo
#   (lint, test, install) — @mf/harness switches to it when WORKER_UID is set. A model-driven
#   shell therefore cannot read the job's memory or /proc/<pid>/environ, so nothing the job
#   holds (report token, cached task-role credentials) is reachable from a worker.
# Both share `/work` through the `work` group: the dir carries the setgid bit, the job writes
# with umask 002 and git runs with core.sharedRepository=group (set by the harness), so the
# uids can edit each other's files without any chown ping-pong.
# The Agent SDK's Claude Code process refuses `bypassPermissions` as root, which the worker uid
# also satisfies; the job/workspace code above stays root-owned read-only.
RUN addgroup -g 1002 work \
	&& adduser -D -u 1001 worker && addgroup worker work && addgroup node work \
	&& mkdir -p /work /home/node/.claude /home/worker/.claude \
	&& chown node:work /work && chmod 2775 /work \
	&& chown -R node:node /home/node && chmod 700 /home/node \
	&& chown -R worker:worker /home/worker && chmod 700 /home/worker
ENV HOME=/home/node CLAUDE_CONFIG_DIR=/home/node/.claude WORK_DIR=/work TEMPLATE_DIR=/usr/src/templates/web \
	WORKER_UID=1001 WORKER_GID=1001 WORKER_HOME=/home/worker

# Golden template every customer build starts from, with its node_modules pre-installed so the
# seeded repo never needs the registry at runtime. The worktrees hard-link these, which Linux
# (`fs.protected_hardlinks`) only allows for files the linking user owns — hence node-owned.
COPY --chown=node:node templates/web ./templates/web/
USER node
RUN cd templates/web && npm ci --ignore-scripts --no-audit --no-fund

WORKDIR /usr/src/apps/job
# Privilege choice: the container starts as root only so that setpriv can hand the job process
# CAP_SETUID + CAP_SETGID as *ambient* capabilities (the only way an unprivileged uid can later
# switch to another uid without a setuid binary); the bounding set is cut to those two, so no
# process in the container can ever hold anything else. The harness spawns every child through
# `setpriv --inh-caps=-all --ambient-caps=-all --no-new-privs` (+ `--reuid=worker` for worker
# sessions), so the two capabilities stay in the node process alone. node is PID 1 after the
# exec (SIGTERM from ecs:StopTask reaches the job directly).
USER root
CMD ["setpriv", "--reuid=node", "--regid=node", "--init-groups", \
	"--bounding-set=-all,+setuid,+setgid", "--inh-caps=+setuid,+setgid", "--ambient-caps=+setuid,+setgid", \
	"node", "src/index.ts"]
