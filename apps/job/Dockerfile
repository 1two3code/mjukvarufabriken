FROM --platform=linux/amd64 node:24-alpine3.22

# git for worktrees/merges, bash + coreutils for the agent's shell tool, ripgrep for Grep
RUN apk add --no-cache git bash coreutils ripgrep

WORKDIR /usr/src

# Workspace dependencies (same layout as apps/api/Dockerfile) — nothing customer-specific
COPY package*.json ./
COPY tsconfig*.json ./
COPY packages ./packages/
COPY apps/job ./apps/job/
RUN npm i --omit=dev --ignore-scripts

# The Agent SDK's Claude Code process refuses `bypassPermissions` as root, so the job runs as
# the unprivileged `node` user (uid 1000, present in the base image). It owns the work dir and
# its own HOME for Claude Code state; the job/workspace code above stays root-owned read-only.
ENV HOME=/home/node CLAUDE_CONFIG_DIR=/home/node/.claude WORK_DIR=/work TEMPLATE_DIR=/usr/src/templates/web
RUN mkdir -p /work /home/node/.claude && chown -R node:node /work /home/node
USER node

# Golden template every customer build starts from, with its node_modules pre-installed so the
# seeded repo never needs the registry at runtime. The worktrees hard-link these, which Linux
# (`fs.protected_hardlinks`) only allows for files the linking user owns — hence node-owned.
COPY --chown=node:node templates/web ./templates/web/
RUN cd templates/web && npm ci --ignore-scripts --no-audit --no-fund

WORKDIR /usr/src/apps/job
CMD ["npm", "start", "--silent"]
