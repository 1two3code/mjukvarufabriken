FROM --platform=linux/amd64 node:24-alpine3.22

# git for clones/worktrees/merges, bash + coreutils for the agent's shell tool, ripgrep for Grep,
# setpriv (util-linux) for the uid/capability switch below
RUN apk add --no-cache git bash coreutils ripgrep setpriv

WORKDIR /usr/src

# Workspace dependencies only (same layout as apps/job/Dockerfile); build context is the repo root
COPY package*.json ./
COPY tsconfig*.json ./
COPY packages ./packages/
RUN npm i --omit=dev --ignore-scripts --workspace @mf/resident --include-workspace-root

# Same two-uid layout as apps/job/Dockerfile: the resident process (uid `node`, holds the GitHub
# App token and the S3 client) and the worker sessions + the repo's own scripts (uid `worker`,
# switched to by @mf/harness when WORKER_UID is set) share `/work` through the `work` group.
# The Agent SDK's Claude Code process refuses `bypassPermissions` as root; both uids satisfy that.
RUN addgroup -g 1002 work \
	&& adduser -D -u 1001 worker && addgroup worker work && addgroup node work \
	&& mkdir -p /work /home/node/.claude /home/worker/.claude \
	&& chown node:work /work && chmod 2775 /work \
	&& chown -R node:node /home/node && chmod 700 /home/node \
	&& chown -R worker:worker /home/worker && chmod 700 /home/worker
ENV HOME=/home/node CLAUDE_CONFIG_DIR=/home/node/.claude WORK_DIR=/work PORT=5176 ADDRESS=0.0.0.0 \
	WORKER_UID=1001 WORKER_GID=1001 WORKER_HOME=/home/worker

WORKDIR /usr/src/packages/resident
EXPOSE 5176
# Starts as root only so setpriv can hand the resident CAP_SETUID/CAP_SETGID (worker-uid switch)
# and CAP_KILL (signalling worker processes) as ambient capabilities (see apps/job/Dockerfile)
CMD ["setpriv", "--reuid=node", "--regid=node", "--init-groups", \
	"--bounding-set=-all,+setuid,+setgid,+kill", "--inh-caps=+setuid,+setgid,+kill", "--ambient-caps=+setuid,+setgid,+kill", \
	"node", "src/index.ts"]
