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

# Golden template every customer build starts from, with its node_modules pre-installed so the
# seeded repo never needs the registry at runtime (the worktrees hard-link these).
COPY templates/web ./templates/web/
RUN cd templates/web && npm ci --ignore-scripts --no-audit --no-fund

# Claude Code (Agent SDK) writes its state under HOME; keep it inside the container
ENV HOME=/root CLAUDE_CONFIG_DIR=/root/.claude WORK_DIR=/work TEMPLATE_DIR=/usr/src/templates/web
RUN mkdir -p /work /root/.claude

WORKDIR /usr/src/apps/job
CMD ["npm", "start", "--silent"]
