# @mf/api

Fastify 5 BFF, executed directly by Node (no build step) and tested with Vitest. Deployed as a Docker image on ECS Fargate (see `infra/`).

## Scripts

- `start` — runs the server using the ambient environment (what the container runs).
- `start:dev` — watch mode with `.env.dev` (copy `.env.example`).
- `test` — runs the tests.
- `lint` — ESLint + `tsgo --noemit`.
- `tsgo:watch` — type-check in watch mode.

## Folder structure

- `src/plugins` — infrastructure singletons decorated on the Fastify instance (`secrets`, `store`, `authKeys`, `auth`, `email`, `anthropic`, `accessControl`, `errorHandling`).
- `src/services` — business logic; a facade over the data plugins.
- `src/routes` — the BFF surface under `/bff/*`, auto-loaded, files named by action.
- `src/lib` — internal helpers that aren't tied to a single plugin or service (domain error classes).
- `test/` — mirrors `src/` one-to-one. `createTestApp()` and `networkMock` are globals.

## Auth

Passwordless magic links; the api is its own token issuer.

| Route | Auth | Purpose |
|---|---|---|
| `POST /bff/auth/magic-link` `{ email }` | public | Emails a single-use link (`${PORTAL_URL}/auth/callback?token=…`, 15 min, max 3 per email per 10 min). Always `202 {}`. |
| `POST /bff/auth/verify` `{ token }` | public | Consumes the link → `{ token, refreshToken }`. First sign-in creates the user and an org named after the email domain. `401 invalidMagicLink` otherwise. |
| `POST /bff/auth/refresh` `{ refreshToken }` | public | Rotates the refresh token → new pair. `401` when unknown/expired. |
| `POST /bff/auth/logout` `{ refreshToken }` | public | Revokes the refresh token → `204`. |
| `GET /bff/session` | bearer | The signed-in `user` + `org`. |
| `GET /.well-known/jwks.json` | public | Public signing key (`kid` = JWK thumbprint). |

Access tokens are EdDSA (Ed25519) JWTs, 1 h, claims `sub` (user id), `email`, `name`, `role`, `orgId`, `iss` = `AUTH_ISSUER`, `aud` = `AUTH_AUDIENCE`; the `auth` plugin verifies them with the local public key from `authKeys`. Refresh tokens are opaque (32 random bytes), stored as sha256, 30 days.

Environment: `AUTH_JWT_PRIVATE_KEY` (JSON JWK) or `AUTH_JWT_PRIVATE_KEY_SECRET_ARN` (generate with `node scripts/gen-auth-key.mjs`; without either an ephemeral key is used and a warning logged), `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_ADMIN_EMAILS` (comma list → role `admin`), `PORTAL_URL`, `EMAIL_TRANSPORT` (`log` prints the link in the log — the default outside live; `ses` sends via SES v2), `AUTH_EMAIL_FROM`. See `.env.example`.

Storage is the in-memory `store` (`users`, `orgs`, `magicLinks`, `refreshTokens`) until Postgres lands — everything resets on restart.
