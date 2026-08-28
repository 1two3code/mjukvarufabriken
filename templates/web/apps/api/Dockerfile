# --- Stage 1: build the single-page app (needs dev dependencies, e.g. vite) ---
FROM --platform=linux/amd64 node:24-alpine3.22 AS build

WORKDIR /usr/src
COPY package*.json ./
COPY tsconfig*.json ./
COPY packages ./packages/
COPY apps ./apps/

RUN npm ci --ignore-scripts
# Root build runs each workspace's build script (the SPA -> apps/app/dist/live)
RUN npm run build

# --- Stage 2: runtime — the API serves its own /bff routes and the built SPA ---
FROM --platform=linux/amd64 node:24-alpine3.22

WORKDIR /usr/src
COPY package*.json ./
COPY tsconfig*.json ./
COPY packages ./packages/
COPY apps/api ./apps/api/

RUN npm i --omit=dev --ignore-scripts

# The production SPA build, served by the API at "/"
COPY --from=build /usr/src/apps/app/dist/live ./spa

WORKDIR /usr/src/apps/api
ENV ADDRESS=0.0.0.0 PORT=80 SPA_DIR=/usr/src/spa
CMD ["npm", "start"]
