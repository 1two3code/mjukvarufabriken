# Wave 4 — leftovers that are code-only (2026-08-27, after waves 1–3)

Same rules as README.md. Four streams, disjoint areas.

## Stream: github-signin (PLAN M6)
Areas: `apps/api` (`plugins/githubOAuth.ts`, `routes/bff/auth/github*.ts`, `services/authService.ts`
additions, tests), `apps/portal` (login page button + `/auth/github/callback` route), `packages/models`
(User `githubId`/`githubLogin`), `packages/db` (migration `0008_users_github.sql` + users repo
columns), `infra/lib/web-stack.ts` + `config.ts` (`GITHUB_OAUTH_CLIENT_ID`, secret
`github-oauth-client-secret` in Secrets Manager placeholders — resources-stack `ExternalSecretName`
list), `TODO-EXTERNAL.md`.
- `GET /bff/auth/github` → redirect to GitHub authorize (state in an httpOnly cookie, PKCE not
  needed for server-side apps but use `state`), `GET /bff/auth/github/callback` → exchange code,
  fetch `/user` + `/user/emails` (primary verified email), link to the existing user by email or
  create user+org (same rules as magic link), set `githubId`/`githubLogin`, issue the same
  session/refresh tokens, redirect to the portal. Behind a `GitHubOAuthClient` interface with a fake;
  routes return 404 when not configured. Also set `Order.customerGithubLogin` from the signed-in
  user when an order is created (m5 delivery uses it for repo transfer).
- Portal: "Logga in med GitHub / Sign in with GitHub" button on the login page when
  `VITE_GITHUB_SIGNIN=1`; callback page reuses the magic-link callback flow.
- Tests for state mismatch, unverified email, linking, new user.

## Stream: billing-and-tls (PLAN M8 box 3 + M9 TLS)
Areas: `apps/api` (`services/paymentService.ts` usage-billing additions, `routes/internal/resident*`
persistence), `packages/db` (migration `0009_resident_usage.sql` + repo), `packages/models`,
`apps/api/Dockerfile`, `apps/job/Dockerfile`, `packages/db/src/index.ts` (sslMode default
`verify-full` for RDS hosts), `infra` (nothing unless an env var is needed).
- Resident usage records persisted (table), monthly aggregation per installation, and Stripe
  usage-based billing through the existing `PaymentProvider` interface (metered price id from
  config; fake provider records the usage report). Admin endpoint listing usage per org/month.
- TLS to RDS with certificate verification: bake the RDS global CA bundle
  (https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) into the api and job images
  at a fixed path, set `NODE_EXTRA_CA_CERTS`, make `sslMode` return `verify-full` for
  `*.rds.amazonaws.com` hosts and keep `require` as an explicit override. Test `sslMode`.
  Tick PLAN M9 TLS item as "code verified, deploy pending".

## Stream: api-hygiene
Areas: `apps/api` (`services/*` rate limiters, `authService` pruning, `specService.get` guard),
`packages/db` (`rate_limits` table migration `0010_rate_limits.sql` or reuse `magic_links` counts),
`.github/workflows/ci.yml`.
- Move the magic-link and contact rate limiters to the db repositories (memory fallback keeps
  working); schedule `pruneAuth` (a `setInterval` in the api with jitter, once per hour, only on
  Postgres) and prune expired rate-limit rows the same way.
- `specService.get` must not auto-create a draft for an unknown order id: orders are created via
  `POST /bff/orders` (m6); unknown ids → 404. Update tests and the portal if it relied on it.
- CI: add `infra/resident` install + synth + test; `npm audit` step stays allow-fail.

## Stream: legal-drafts (PLAN M10 box 2)
Areas: `legal/` (new), `TODO-EXTERNAL.md`.
- Swedish drafts, marked DRAFT — EJ GRANSKAD on every page, for lawyer review: `kundavtal.md`
  (fixed-price build: scope = frozen spec, 50/50 payment, acceptance = passed gates + customer
  review window 10 working days, IP transfer on final payment, liability cap = contract value,
  AI-generated code disclosure, third-party licence pass-through), `pub-avtal.md` (GDPR data
  processing agreement per art. 28 with sub-processors AWS eu-north-1, Anthropic, GitHub, Stripe),
  `sla-resident.md` (resident-agent mode: token cap, pause, audit log, monthly fee, no uptime SLA
  in v1), `villkor-webb.md` (site terms + privacy policy incl. cookies: none beyond session).
  Plain Markdown, numbered clauses, an English summary section at the end of each. No PLAN box
  tick (needs lawyer review — TODO-EXTERNAL already has the row).
