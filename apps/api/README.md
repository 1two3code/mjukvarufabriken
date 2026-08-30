# @mf/api

Fastify 5 BFF, executed directly by Node (no build step) and tested with Vitest. Deployed as a Docker image on ECS Fargate (see `infra/`).

## Scripts

- `start` — runs the server using the ambient environment (what the container runs).
- `start:dev` — watch mode with `.env.dev` (copy `.env.example`).
- `test` — runs the tests.
- `lint` — ESLint + `tsgo --noemit`.
- `tsgo:watch` — type-check in watch mode.

## Folder structure

- `src/plugins` — infrastructure singletons decorated on the Fastify instance (`secrets`, `db`, `authKeys`, `auth`, `email`, `anthropic`, `accessControl`, `errorHandling`).
- `src/services` — business logic; a facade over the data plugins. `specService.get` never creates a draft: orders come from `POST /bff/orders`, an unknown order id is 404.
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

Storage is Postgres via `app.db` (`users`, `orgs`, `magic_links`, `refresh_tokens` — see `packages/db`). Without `DATABASE_URL` / `DATABASE_SECRET_ARN` the api boots on the in-memory repositories and logs it: everything then resets on restart. A configured secret that cannot be read is a failure, not a fallback: `app.db.available` is false, every repository call rejects and `/health` returns 503. Housekeeping runs only on Postgres: the `pruner` plugin (`src/plugins/pruner.ts`) calls `db.auth.pruneExpired()` (expired magic links and rotated refresh tokens) and `db.rateLimits.pruneExpired()` (contact-form hits older than the retention) and logs one summary line, scheduled by `src/lib/housekeeping.ts` shortly after boot and then hourly with a random 0–5 min jitter so tasks started together do not prune at once; the first run is never awaited during registration. On the memory backend the repositories sweep themselves on insert.

Rate limits: the magic-link limiter counts `magic_links` rows per email; the contact-form limiter (per ip and a global ceiling per window) counts `rate_limits` rows, so every api task shares the same counts. Both record the attempt *before* sending the email. When the database is configured but unavailable the contact form keeps working on a process-local limiter (logged as a warning) instead of failing — it only needs the mailer.
