FROM --platform=linux/amd64 node:24-alpine3.22

WORKDIR /usr/src

# RDS TLS (M9): @mf/db ships the pinned RDS CA bundle (packages/db/certs) and trusts it for
# the Postgres connection only — no download at build time, nothing added to Node's store.

# Copy workspace dependencies
COPY package*.json ./
COPY tsconfig*.json ./
COPY packages ./packages/
COPY apps/api ./apps/api/

# Install dependencies
RUN npm i --omit=dev --ignore-scripts

# Start app
WORKDIR /usr/src/apps/api
ENV ADDRESS=0.0.0.0 PORT=80
CMD ["npm", "start"]
