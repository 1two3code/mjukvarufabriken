FROM --platform=linux/amd64 node:24-alpine3.22

# git for clones/worktrees/merges, bash + coreutils for the agent's shell tool, ripgrep for Grep
RUN apk add --no-cache git bash coreutils ripgrep

WORKDIR /usr/src

# Workspace dependencies only (same layout as apps/job/Dockerfile); build context is the repo root
COPY package*.json ./
COPY tsconfig*.json ./
COPY packages ./packages/
RUN npm i --omit=dev --ignore-scripts --workspace @mf/resident --include-workspace-root

# The Agent SDK's Claude Code process refuses `bypassPermissions` as root, so the resident runs
# as the unprivileged `node` user: it owns the work dir and its own HOME for Claude Code state.
ENV HOME=/home/node CLAUDE_CONFIG_DIR=/home/node/.claude WORK_DIR=/work PORT=5176 ADDRESS=0.0.0.0
RUN mkdir -p /work /home/node/.claude && chown -R node:node /work /home/node
USER node

WORKDIR /usr/src/packages/resident
EXPOSE 5176
CMD ["node", "src/index.ts"]
