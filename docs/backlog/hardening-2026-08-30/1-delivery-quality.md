# Delivery Pipeline Audit — Broken-Ship Report

Same class as the original guestbook incident: the app loads, the backend is dead. Findings grouped by failure mode, most-severe first within each group. Every citation verified against current source.

---

## A. auth-allowlist-gap — the SPA calls a route that 401s for the delivered visitor

This is the *un-fixed second half* of the guestbook incident. wiredSmoke closed the 404 half; the 401 half is wide open, by design (`wiredSmoke.ts:23-25` deliberately treats 401 as "route exists → pass"). Nothing in the pipeline ever reconciles delivered routes with the auth allowlist.

**A1 — CRITICAL — `templates/web/apps/api/src/plugins/auth.ts:33`**
`publicUrls` is a hardcoded `Set(['/bff/auth/refresh'])`. The `onRequest` hook (`auth.ts:49-51`) 401s every `/bff` route not in that set. No code in `delivery/*`, `envManifest.ts`, `ecsExpress.ts`, or the worker prompt ever edits `auth.ts` or populates `publicUrls`, and the worker conventions never mention the allowlist exists.
Scenario: worker builds a public guestbook, correctly registers `app.post('/bff/guestbook')`, does not add it to `publicUrls`. Unauthenticated visitor's `POST /bff/guestbook` → 401 in production. wiredSmoke probes with no `Authorization` header (`wiredSmoke.ts:194`), gets 401, `wiringFailures()` keeps only `status===404` (`wiredSmoke.ts:204-205`) → green → ships. Every anonymous call is rejected; page never loads.
Fix (two parts):
- *Make the contract discoverable to the worker*: add to `worker.ts` repoConventions a hard statement that any anonymous-facing route MUST be added to `publicUrls` in `plugins/auth.ts`, and that everything under `/bff` is closed by default.
- *Make the gate catch it*: teach wiredSmoke to distinguish "intended-public but 401" from "correctly-auth-gated". Concretely — probe each extracted call **twice**: once with no token and once with a freshly-minted valid token for the injected auth contract (envManifest already owns `AUTH_ISSUER/JWKS/AUDIENCE`; mint a matching JWT). If the no-token probe is 401 **and** the token probe is 2xx/400, the route is auth-gated (fine). If *both* are 401, or the app declares itself anonymous, flag it. At minimum, cross-check every extracted frontend path against the `publicUrls` set parsed from `auth.ts` and warn on any probed path that isn't allowlisted, since the delivered preview has no working login (refresh returns 501, no IdP) so the visitor never holds a token anyway.

**A2 — CRITICAL — `templates/web/apps/api/src/plugins/auth.ts:51`**
`if (publicUrls.has(incomingUrl) || !incomingUrl.startsWith('/bff')) return` — the `/bff` prefix is the *only* thing that arms the JWT guard. Nothing tells the worker this (`worker.ts` conventions lines ~54-63,111-130 never state it).
Scenario: worker builds an admin API and registers `app.get('/admin/users')` or `app.get('/api/orders')` to match a spec's URL shape. Those routes require **no token at all** — `request.session` is never set, accessControl no-ops. Protected data served publicly: a silent security inversion. No gate detects it — wiredSmoke only judges 404, never "should be protected but is reachable unauthenticated". (For the frontend+backend to *agree* on the non-`/bff` path and thus actually work-yet-be-open, both halves must deviate together — but the guestbook proved workers do deviate on prefixes.)
Fix: `server.ts`/`index.ts` should refuse to mount, or the delivery pipeline should scan the built route table and hard-fail, any route outside `/bff` that isn't an explicit infrastructure route (`/health`). Alternatively invert the guard to closed-by-default for *all* routes with an explicit public prefix list. Add the `/bff`-arms-auth fact to worker conventions.

**A3 — HIGH — `templates/web/apps/api/src/plugins/auth.ts:50`**
The guard keys on `request.routeOptions.url` (the registered *pattern*) and tests with `Set.has` (exact string). A public parametric route registered as `/bff/guestbook/:id` has pattern `'/bff/guestbook/:id'`; an operator/worker who allowlists the intuitive `'/bff/guestbook'` or a concrete `'/bff/guestbook/123'` gets a silent 401 — neither string equals the `:id` pattern. No prefix/subtree support; every public route must be enumerated verbatim with param tokens. Nothing validates `publicUrls` entries against the registered route table.
Fix: add a startup assertion that every `publicUrls` entry matches a registered `routeOptions.url` exactly (fail fast on a typo), and/or support subtree allowlisting (`startsWith` on a declared public prefix). Surface unmatched allowlist entries as a boot error so the mismatch dies in the boot smoke, not the browser.

---

## B. gate-blindspot — wiredSmoke extracts the wrong probe set (or none)

The gate's coverage is only as good as its regex extraction. Several shapes silently produce zero or wrong probes, and a zero-probe run *passes*.

**B1 — HIGH — `wiredSmoke.ts:168`** (whole gate no-ops)
`extractFrontendApiSurface` anchors solely on `readEnvValue(.env.live ?? .env, 'VITE_API_URL')` (`wiredSmoke.ts:165-168`); if absent it returns `undefined` and `createWiredSmokeCheck` returns `ok:true` "no discoverable frontend surface" (`wiredSmoke.ts:331-333`). A worker that inlines `fetchBaseQuery({ baseUrl: '/api' })` or reads a differently-named var leaves no `VITE_API_URL` → the entire frontend↔backend gate is skipped and passes. App can mount every route under the wrong prefix and ship green.
Fix: when a frontend app dir exists but no `VITE_API_URL` is found, do not silently pass — parse the base directly from `fetchBaseQuery({ baseUrl: ... })` in `api.ts`, and if the app clearly has API slices but no resolvable base, return a *warning/failure* ("frontend surface undiscoverable — cannot verify wiring") rather than a green pass. Fail-closed for the "has slices, no base" case.

**B2 — HIGH — `wiredSmoke.ts:69` / `:332`** (parametric-only surface → zero probes)
`isProbablePath` drops any literal with `${`, `+`, or a trailing `/`. An app whose data surface is entirely id-keyed (`GET/PATCH/DELETE /bff/notes/${id}`, `POST /bff/notes/${id}/comments`) extracts **zero** probable paths → `calls.length===0` → `ok:true` "no static frontend API calls to verify". If the worker mounted those under the wrong prefix, every click 404s while the gate verified nothing. The parameterized version of the exact guestbook bug.
Fix: for interpolated paths, probe the **static prefix** up to the first `${`/param segment (e.g. probe `/bff/notes/` subtree existence, or substitute a sentinel value `1`/`smoke` and treat 404-on-the-whole-prefix as a wiring failure while ignoring a 404 that's plausibly "id not found"). At minimum, if `calls.length===0` **but** RTK slices were found, downgrade from a clean pass to an explicit "surface present but unverifiable" signal so an all-parametric app isn't reported as verified.

**B3 — HIGH — `wiredSmoke.ts:89`** (un-parenthesized single-arg arrow skipped)
The arrow-returns-string extractor requires literal parens: `/query:\s*\([^)]*\)\s*=>.../`. With `arrowParens: "avoid"` enforced repo-wide, `getPosts: builder.query({ query: filter => '/posts' })` is idiomatic — and it's matched by *neither* regex (no `url:` key either). `/posts` never enters the probe set; if `GET /bff/posts` was never registered (prefix drift), the gate reports "endpoints resolve" and the browser list 404s.
Fix: relax the arrow regex to accept both parenthesized and bare single params: `/query:\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*['"`]([^'"`]*)['"`]/`. Add a fixture for the bare-arg form.

**B4 — MEDIUM/HIGH — `wiredSmoke.ts:94`** (method inferred from a forward 200-char window)
For a `url:` match, method is the *first* `method:` in `source.slice(index, index+200)`, else GET. Two failures:
- *method-first ordering*: `query: b => ({ method:'POST', url:'/subscribe' })` has no `method:` after the url in-window → defaults GET. Gate probes `GET /bff/subscribe`; a POST-only backend route either false-404-blocks a good app or leaves the real POST route unprobed.
- *bleed*: `{ url:'/x' }` (GET) followed within 200 chars by `{ url:'/y', method:'POST' }` makes `/x` probe as POST → false 404 on a correctly-wired GET, blocking delivery.
The template's `itemsApiSlice` happens to be immune (its object-GET is 413 chars from the next `method:` via `providesTags`), but workers emit arbitrary density.
Fix: parse the method from the **same endpoint object**, not a fixed char window. Extract the balanced `{ ... }` object around each `url:` (or split slices on endpoint boundaries) and read `method:` only within that object; default GET only when the object truly has none.

---

## C. env-drift — the app boots on a value that is wrong live

envManifest's "boot-past-placeholder" tradeoff (`envManifest.ts:9-18`) is deliberate for crashloop-avoidance, but it converts a loud 503 into a silent live 500.

**C1 — HIGH — `packages/harness/src/job/delivery/deliver.ts:194`** (placeholder ships into the live container)
A generated app declares `required = ['STRIPE_SECRET_KEY']` (used lazily in a route). `buildEnvManifest` injects `STRIPE_SECRET_KEY=TODO_SET_BY_OPERATOR_STRIPE_SECRET_KEY` (`envManifest.ts:172`, placeholder path). `deliver.ts:189-201` only logs a TODO and sets `deployReason` — it does **not** skip the deploy. Boot smoke passes (secrets presence check `!process.env[name]` is satisfied by the non-empty placeholder), wiredSmoke sees 200/401 not 404, so `deliver.ts:212-224` stands up the ECS service with the **same placeholder env** (`deliver.ts:218`) and returns `deployUrl` non-null / `ok:true`. Customer gets a live URL whose Stripe-touching calls 500 at runtime.
Fix: gate the deploy on `manifest.placeholders.length`. Either (a) block the deploy when any placeholder is present and mark the job "delivered-pending-operator-env" (surface via TODO-EXTERNAL rather than shipping a live URL), or (b) deploy but mark the returned deliverable `degraded: true` with the placeholder list, and do **not** present it to the customer as a working URL. The current code path returns full success.

**C2 — HIGH — `envManifest.ts:33`** (only the literal `required = [...]` array is detected)
`parseRequiredEnv` matches only `required\s*(?::…)?=\s*[…]`. An app that validates env any other way — Zod (`z.object({ DATABASE_URL: z.string().url() })`), destructure-and-throw, or bare `process.env.DATABASE_URL!` — declares its requirement invisibly. `detectRequiredEnv` returns `[]`, so `buildEnvManifest` injects only the always-on app secrets + auth contract; `DATABASE_URL`/`REDIS_URL` is **absent** from both the boot env (`deliver.ts:205`) and the live container (`deliver.ts:218`). Eager validators fail the boot smoke (caught, good). But a **lazily-consumed self-issued secret** declared outside `required` (e.g. `SESSION_SECRET` read at first request) is neither detected nor minted, absent live, and only 500s in the browser.
Fix: broaden detection to additionally scan `secrets.ts`/`config.ts` for `process.env.X`/`env.X` reads and Zod `z.object({ … })` keys, unioning env-var-shaped names into `required`. Even a superset is safe here — an unknown name yields a placeholder (loud) rather than an absent var (silent).

**C3 — MEDIUM — `envManifest.ts:103`** (self-issued heuristic mints a random value for a shared secret)
`selfIssuedToken` matches any name containing `JWT/SIGNING/TOKEN/SESSION/COOKIE/CSRF`; `isSelfIssuedSecret` then mints `randomBytes(48)`. The external-provider allowlist (`envManifest.ts:95`) only catches *prefixed* names. A `SIGNING_SECRET`/`JWT_SECRET` on an app that is a *consumer* of a partner's HMAC-signed tokens/webhooks (pre-shared key, no provider prefix) is misclassified self-issued → random value. Boots, ships, and every signature verification 401/400s live because the minted secret ≠ the counterparty's. The name-based heuristic can't tell issuer from consumer.
Fix: this is the weakest of the set (in a self-contained generated app `JWT_SECRET` is usually the app's own key). Narrow the risk: keep minting for `SESSION/COOKIE/CSRF` and bare `SECRET_KEY`, but for `SIGNING`/generic `*_SECRET` names, prefer a flagged placeholder + TODO over a silent mint when the app's code shows a *verify*-only usage (no corresponding sign/issue call). Lower priority than C1/C2.

---

## D. migration-gap / build-vs-runtime — infrastructure the delivered app needs is never provisioned or exercised

**D1 — CRITICAL — `templates/web/apps/api/Dockerfile:30` (+ `ecsExpress.ts` deployFromRepo, `infra/lib/resources-stack.ts:316-332`)**
Template ships an in-memory `store` (`plugins/store.ts:16-19`) and CLAUDE.md instructs workers to "swap it for a real database client". When a worker adds `pg`/`postgres` + DDL/migrations, **nothing** applies the schema or stands up a DB: the runtime entrypoint is `CMD ["npm","start"]` → `server.listen` with no migrate; CodeBuild only `docker build`/`push`; ECS Express creates a service + ALB, no RDS/DynamoDB. Contrast the factory's own app, which runs `await migrate(db)` at boot (`apps/api/src/plugins/db.ts`, `apps/job/src/reporter.ts:202`) — the delivered app has no analog. A lazy-connecting DB store boots, serves the SPA, passes wiredSmoke (500 ≠ 404), and 500s on every read/write against a database that was never created.
Fix: two options, in order of robustness — (a) delivery detects a real DB dependency (a `migrations/` dir, `pg`/`postgres`/`drizzle`/`@aws-sdk/client-dynamodb` in the delivered `package.json`, a `DATABASE_URL` in required env) and either provisions a preview DB + runs migrations before deploy, or fails-closed with a clear "needs a database, not provisionable in preview" status instead of shipping a live-but-dead URL; (b) at minimum, when a DB dependency is detected but no `DATABASE_URL`/datastore is wired, block the deploy the same way C1 should. An eager `migrate()` at boot would at least fail-closed in the boot smoke — worth adding to the delivered Dockerfile entrypoint pattern the worker is told to follow.

**D2 — HIGH — `wiredSmoke.ts:254`** (the SPA is never served or rendered before the customer visits)
The "frontend loads" promise rides on the container serving the built SPA at `/`. The delivered image sets `SPA_DIR=/usr/src/spa` (`Dockerfile:29`) and `index.ts:28` does `if (SPA_DIR) await registerSpa(...)`. But delivery's boot injects `manifest.env`, and `bootAndHold` only adds `PORT/ADDRESS/HOST` (`wiredSmoke.ts:254`) — `SPA_DIR` is **undefined** during the smoke, so `registerSpa` is skipped and the SPA is never served/rendered by any gate. Gates are lint+test only (`worker.ts:180`, `gates.ts:10`); `vite build --mode live` first runs inside CodeBuild *after* the smoke passed; `scripts/smoke-spa.mjs` is a template-CI script the harness never invokes. A misconfigured Vite `base` (assets 404 → blank page) or a production-bundle-only JS runtime error ships as a "working" URL showing a blank/404 page. Nothing between build-green and the browser ever loads the page.
Fix: add a render smoke to the delivery gate — after the image/bundle is built (or by building the SPA in-gate), boot with `SPA_DIR` set to the built `dist/live`, `GET /`, assert 200 + an HTML body containing the app root, and fetch one referenced `/assets/*` and assert 200 (catches `base` misconfig). Run headless-render (`smoke-spa.mjs`) against the booted origin so a bundle-only runtime error is caught before delivery.

**E — HIGH — `wiredSmoke.ts:55`** (absolute `VITE_API_URL` host is discarded)
`parseViteApiBase` keeps only `new URL(value).pathname` for an absolute value (`wiredSmoke.ts:55-62`). If a worker leaves an absolute base in the live env (`VITE_API_URL=http://localhost:5174/bff` or a stale staging host), the `dist/live` bundle bakes that absolute URL into the browser's fetches, but the gate strips it to `/bff` and probes its own boot origin → passes. The delivered SPA calls the wrong origin in the browser (connection refused / CORS) and every call fails.
Fix: if `VITE_API_URL` is absolute, fail (or hard-warn) the gate unless its host matches the delivery's own preview origin — a same-origin relative base is the only safe form for the delivered container. Verify the host, don't discard it.

---

## Biggest risk to the delivery promise

Ships a broken app to a paying customer, in rough order of how routinely it bites:

1. **A1/A2 (auth allowlist, CRITICAL)** — any anonymous-facing or non-`/bff` route ships 401/unauthenticated. This is the literal un-fixed second half of the incident that motivated the whole gate, and it is *provably* invisible: wiredSmoke's 401-is-pass is documented, not defended against.
2. **D1 (no DB provisioning, CRITICAL)** — the moment a spec wants persistence (guestbook, todo, anything surviving a redeploy), the worker swaps the in-memory store, and the delivered app 500s on every call against a database that doesn't exist. The factory's stated purpose (small/medium web apps) makes this antecedent likely, not exotic.
3. **C1 (placeholder env ships live, HIGH)** — deploy is never blocked on placeholders; any external-provider route 500s live behind a URL presented as working.
4. **D2 + E (SPA never rendered, wrong host baked in, HIGH)** — blank/404 page or wrong-origin fetches, both green through every gate.
5. **B1/B2/B3 (gate no-ops, HIGH)** — the gate that exists to catch prefix drift silently verifies *nothing* for common shapes (no `VITE_API_URL`, all-parametric surface, bare-arg arrows).

## Systemic gate improvements (close a class, the way wiredSmoke closed 404-routing)

- **Token-aware probing + allowlist reconciliation** closes the entire auth-allowlist-gap class (A1–A3) at once: probe every extracted call with and without a minted valid token, and cross-check each probed path against the `publicUrls` set parsed from `auth.ts`. Turns "401 = pass" into "401-for-both = fail, and any probed path not registered-or-allowlisted = fail."
- **Fail-closed on undiscoverable/empty surface** closes the gate-blindspot class (B1/B2): when API slices exist but the probe set is empty or the base is unresolvable, return an explicit non-pass instead of a clean green. A gate that reports "verified nothing" as success is the root pattern behind B1, B2, and the whole-gate-skip.
- **A real render + dependency smoke** closes build-vs-runtime + migration-gap (D1/D2/E): build the SPA and serve it with `SPA_DIR` set, `GET /` + one asset, headless-render; and detect DB/external-provider dependencies and either provision+migrate or fail-closed rather than shipping a live URL. This extends the wiredSmoke philosophy ("boot the real thing and exercise the real contract") from the API routes to the frontend render and the datastore — the two remaining halves of "the URL works" that no gate touches today.
- **Block delivery on placeholders/degraded env** (C1/C2): make `manifest.placeholders.length > 0` a deploy gate, not a log line. One check converts a silent live-500 back into the loud, operator-actionable signal the manifest was designed to produce.

Files to change: `packages/harness/src/job/delivery/wiredSmoke.ts` (probing/method/extraction/render — B1-B4, D2, E), `deliver.ts:189-201` (placeholder deploy gate — C1), `envManifest.ts:29-39` (detection breadth — C2) and `:113-120` (consumer-secret handling — C3), `templates/web/apps/api/src/plugins/auth.ts` (allowlist validation/subtree — A3) plus delivery-side allowlist reconciliation (A1), route-prefix enforcement (A2), and DB detection/provisioning around `ecsExpress.ts`/`deliver.ts` (D1). Worker conventions in `packages/harness/src/.../worker.ts` need the `/bff`-arms-auth and `publicUrls` facts stated explicitly for A1/A2.