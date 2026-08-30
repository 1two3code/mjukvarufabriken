# @template/api

Fastify 5 BFF, executed directly by Node (no build step) and tested with Vitest. Deployed as a Docker image on ECS Fargate (see `infra/`).

## Scripts

- `start` — runs the server using the ambient environment (what the container runs).
- `start:dev` — watch mode with `.env.dev` (copy `.env.example`).
- `test` — runs the tests.
- `lint` — ESLint + `tsgo --noemit`.
- `tsgo:watch` — type-check in watch mode.

## Folder structure

- `src/plugins` — infrastructure singletons decorated on the Fastify instance (`secrets`, `store`, `auth`, `accessControl`, `errorHandling`).
- `src/services` — business logic; a facade over the data plugins.
- `src/routes` — the BFF surface under `/bff/*`, auto-loaded, files named by action.
- `src/lib` — internal helpers that aren't tied to a single plugin or service (domain error classes).
- `test/` — mirrors `src/` one-to-one. `createTestApp()` and `networkMock` are globals.
