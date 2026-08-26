# CLAUDE.md

Shared instructions for AI coding assistants working in this repository. Both Claude Code and GitHub Copilot read this file natively — keep it tool-neutral. See [AI tooling in this repo](#ai-tooling-in-this-repo) at the bottom for the layout.

## What this is

A monorepo **template** for a web application: a React SPA talking to a Fastify backend-for-frontend, with shared model/utility packages and AWS CDK infrastructure. The example domain is deliberately tiny — one `Item` entity with a list/create/update flow — so every layer shows the intended pattern without domain noise. Replace `Item` with your own entities and keep the structure.

It is an npm workspaces monorepo written entirely in TypeScript (ESM, `"type": "module"`).

## Runtime and pinned versions

- **Runtime**: Node.js ≥ 24.14, npm 11+. TypeScript files are executed directly by Node, so there is no build step for the API and imports carry the `.ts` extension.
- **TypeScript**: 6.x, with `tsgo` 7.x (native preview) doing the type-checking in lint scripts.
- **Test runner**: Vitest 4.x (`projects` defined in the root config, globals enabled).
- **Linting**: ESLint 9 (flat config), Prettier, Stylelint (CSS, app only).
- **Frontend**: React 19 (React Compiler enabled), Vite 8, Redux Toolkit + RTK Query, `react-router-dom` v7, i18next.
- **Backend**: Fastify 5, `fastify-type-provider-zod`, `jose` for JWT verification.
- **Schemas**: Zod 4.
- **Infrastructure**: AWS CDK v2 (S3 + CloudFront for the app, ECS Fargate for the api).

## Repository layout

```
├── apps/
│   ├── api/             # @template/api — Fastify 5 BFF (Docker → ECS Fargate)
│   └── app/             # @template/app — React 19 SPA (Vite → S3 + CloudFront)
├── packages/
│   ├── access-control/  # RBAC roles, permissions, permission-check helpers
│   ├── models/          # Zod schemas + inferred types for every domain entity (shared app↔api)
│   └── utils/           # Pure helpers, subpath exports (@template/utils/function, /date, /object)
├── infra/               # AWS CDK app, one stack per environment (NOT an npm workspace)
├── vitest.config.ts     # Root config — projects (@template/api, @template/utils) + coverage
├── eslint.config.mjs    # Root ESLint flat config (extended by workspaces)
├── tsconfig.json        # Root tsconfig (extended by workspaces)
└── tsconfig.node.json   # Node-specific tsconfig (used by api and packages)
```

`infra/` is excluded from npm workspaces and has its own `package.json` and `node_modules` — use `npm i --prefix infra`.

## Commands

Always run commands from the **repository root**. Run `npm install` first if `node_modules` may be stale.

| Purpose | Command | Notes |
|---|---|---|
| Install | `npm i` | Public npm registry only. |
| Run everything in dev | `npm run start:dev` | App on :5173, api on :5174 (needs `apps/api/.env.dev`, see `.env.example`). |
| Build | `npm run build` | Only `@template/app` builds — Vite, one dist per mode (`dev`, `live`). |
| Lint | `npm run lint` | ESLint + `tsgo --noemit` per workspace; also Stylelint in the app. |
| Lint one workspace | `npm run lint -w @template/api` | `-w` takes the package name or the path (`-w apps/api`); the bare folder name does not resolve. |
| Test (all) | `npm test` | `vitest run` across the two projects. |
| Test one project | `npm test -- --project @template/api` | Project names are package names: `@template/api`, `@template/utils`. |
| Test one file | `npm test -- apps/api/test/routes/bff/items/getItems.test.ts` | |
| Test one case | `npm test -- -t 'Returns the item by id'` | |
| Coverage | `npm run coverage` | V8 coverage → `coverage/lcov.info`. |
| Type-check in watch mode | `npm run tsgo:watch -w @template/api` | Available for api and app; VS Code task `tsgo:watch all` runs both. |

Only `@template/api` and `@template/utils` have tests. The React app has **no test setup** — do not run or add tests there without setting one up first.

## Local development

The app talks to the api directly (`VITE_API_URL` in `apps/app/.env.dev`), no reverse proxy needed. The api verifies JWTs against a JWKS endpoint (`AUTH_JWKS_URL`, `AUTH_ISSUER`, `AUTH_AUDIENCE`); the login page in the template simply accepts a pasted token — replace it with your identity provider's flow.

Env files are per-mode dotenv files inside each app; override locally with `.env.{mode}.local`. The api has `.env.example` (committed) → `.env.dev` (not committed). The app has a committed `.env` base (used as-is by `live`) plus a `.env.dev` override.

## Git hooks

`pre-push` runs `npm run lint` then `npm test`. Commit subjects are validated by `.husky/commit-msg.js` and must follow [Conventional Commits](https://www.conventionalcommits.org):

```
feat(scope): add something   |   fix: correct something   |   chore|docs|refactor|test|ci|build|perf|style: …
```

## Architecture

### API (`apps/api`)

Layered, and everything hangs off the Fastify instance via `app.decorate`:

- **plugins** (`src/plugins/`) — infrastructure singletons registered via `fastify-plugin` (`fp()`). `store` wraps the data layer (an in-memory `Map` in the template — swap it for a real database client while keeping its interface), `secrets` reads configuration from the environment; the rest are cross-cutting (`auth`, `accessControl`, `errorHandling`). Companion `.types.ts` files define module augmentation when it grows.
- **services** (`src/services/`) — business logic, consuming plugins; a facade over the data layer. Companion `.types.ts` and `.utils.ts` files.
- **adapters** (`src/adapters/`, add when needed) — pure transforms from third-party payload shapes into application models.
- **routes** (`src/routes/`) — the BFF surface under `/bff/*`. Named by *action*, not URL path (`getItems.ts`, `updateItem.ts`), nested in folders mirroring the URL. Auto-loaded by `@fastify/autoload`, which ignores `*types.ts`/`*utils.ts`. Each file exports a **default** `FastifyPluginAsyncZod`.

`src/server.ts` composes plugins + services in dependency order and is the single place to register new ones; `src/index.ts` adds autoloaded routes and `/health`. `server.ts` is exported so tests can build a server without listening. (Optional pattern: a `tooling/api-facade` workspace that imports `createServer()` to run one-off operations/migrations headlessly against a real environment.)

Validation and serialization use Zod schemas from `@template/models` through `fastify-type-provider-zod`; a `response` schema is required on every route.

Auth: the `auth` plugin verifies the JWT (`jose`, remote JWKS, issuer + audience) and decorates `request.token` / `request.session` (`{ userId, role }`), with an explicit public-URL allowlist; everything outside `/bff` is public. `accessControl` reads `permissions` off the route config and checks the session role via `@template/access-control`.

Errors: `reply.error(status, error, code?)` comes from the `errorHandling` plugin. Domain errors are `EntityNotFound` / `EntityInvalid` from `#/lib/entityError.ts`. Only pass the third `code` argument when the frontend has a specific, actionable message for it (`api.error.<code>` translation key).

#### Tests

`apps/api/test/` mirrors `src/` one-to-one. `createTestApp()` and `networkMock` are globals (no imports); `setupTests.ts` stubs them and resets MSW between tests. `createTestApp()` auto-mocks **every** file in `src/plugins/__mocks__` and `src/services/__mocks__`; to exercise a real implementation, opt out: `createTestApp({ skipMock: '#/services/itemService.ts' })`. Mocks export `createMock*(overrides)` fixture factories — prefer calling those and overriding only the differing field over hand-writing objects. Route tests drive `app.inject()`. `networkMock` intercepts outgoing HTTP (see `test/plugins/auth.test.ts`, which serves a real JWKS).

### App (`apps/app`)

- `src/app/` is the shell: `store.ts` (`combineSlices`, listener middleware prepended), `api.ts`, `router.tsx`, `hooks.ts` (pre-typed `useAppSelector`/`useAppDispatch`), `i18n.ts`, `types.ts`.
- `src/features/<feature>/` holds domain logic: one `*ApiSlice.ts` per feature, plus slices/contexts/components co-located. `src/components/` is shared UI, `src/pages/` one file per page, `src/layouts/`, `src/hooks/`.
- **Dependency direction: `features/` may import `components/`, never the reverse.**
- State ownership: feature-local UI state → React Context co-located with the feature (`features/items/itemsContext.ts`); app-wide state (session, theme, toasts) → a Redux slice registered in `store.ts`; server data → RTK Query. Do not put feature-local state in Redux.
- RTK Query: never call `createApi` again (ESLint blocks the import) — extend the shared `appApi` from `#/app/api.ts` with `.enhanceEndpoints({ addTagTypes }).injectEndpoints(...)`. `api.ts` also owns the token-refresh mutex on 401 and the middleware that turns coded API errors into toasts. Use the `ApiCaching` constants for `keepUnusedDataFor`.
- React 19 with React Compiler enabled: do **not** add `useMemo`/`useCallback`/`React.memo` to new code. Consume context with `use()`, not `useContext()`; render providers as `<Context value={…}>`.
- Styling is CSS Modules (`Component.tsx` + `Component.module.css`, camelCase class names, design tokens as CSS custom properties in `src/assets/styles/`). Build class lists as arrays and `join(' ')`.
- SVGs import as components via the Vite `?react` suffix.
- User-facing text goes through `useTranslation()`. Locale files live in `public/locales/<lang>.json` (`en` is the source of truth, `sv` is the second example); add every new key to all of them.

### Models (`packages/models`)

Zod 4 schemas in `schemas/`, re-exported from `index.ts`. Files ending in `.api.ts` define API-layer mutation/query/operation schemas; type guards live in `.guards.ts` files. Always export both the schema and its inferred type.

### Infrastructure (`infra/`)

Plain `aws-cdk-lib` constructs, one `WebStack` per environment from `lib/config.ts`. No account numbers in git — they come from `CDK_DEFAULT_ACCOUNT`/`CDK_DEFAULT_REGION`; without them the stacks are environment-agnostic so `cdk synth` runs offline (build the app first).

## Conventions

Full, example-laden rules live in `.claude/rules/*.instructions.md`, one file per area: `typescript`, `api-plugins`, `api-routes`, `api-services`, `api-tests`, `zod-models`, `react-tsx`, `react-components`, `react-features`, `rtk-query`, `css-modules`, `cdk-infrastructure`.

They are applied automatically by both assistants (Copilot via `applyTo`, Claude Code via `paths`), but attachment is not guaranteed on every surface — **read the matching file directly before writing code in that area.** Highlights:

- **No relative parent imports.** Every workspace maps `#/*` to its own source root; ESLint blocks `../*`.
- **Named exports.** `export default` is an ESLint error everywhere *except* API plugins/routes/services/mocks, where autoload requires it.
- Plugins/services register as `fp(plugin, { name: '#internal/camelCaseName', dependencies: ['#internal/...'] })` and declare their surface with `declare module 'fastify'`.
- Companion file naming: `*.types.ts` (types), `*.utils.ts` (pure helpers), `*.api.ts` (Zod API-layer schemas), `*.guards.ts` (type guards), `__mocks__/*.ts`.
- `tryCatch()`/`tryCatchSync()` from `@template/utils/function` return `[error, result]` — use them when you need to branch on the error; a plain `try/catch` is fine for a single catch-all path.
- `as const` objects/arrays with derived union types instead of TS `enum`.
- Prefer `const`; extract any multi-line block into a named helper; `structuredClone()` before mutating; `// MARK:` comments to section longer files.
- Route logic lives in the route file by default — move it to a service only when two routes need it.
- Prettier: tabs, no semicolons, single quotes, 100 cols, arrow parens avoided, with a custom import-order plugin. Don't hand-format imports. Markdown is not Prettier-formatted in this repo.

## AI tooling in this repo

Everything lives under `.claude/`, which Claude Code and GitHub Copilot both read from a fresh clone.

| What | Where | Loaded by |
|---|---|---|
| These instructions | `CLAUDE.md` | Both, natively |
| Per-area conventions | `.claude/rules/*.instructions.md` | Both, when a touched file matches the glob |
| Subagents | `.claude/agents/<name>.md` | Both, on demand |

Subagents: `feature-builder` (issue/description → plan → implementation), `pr-reviewer` and `pr-resolver` (GitHub PRs via the `gh` CLI), `test-writer` (Vitest tests for api services/routes/plugins).

Maintenance rules:

- **Rules files need two frontmatter keys with the same glob: `applyTo:` (a glob string) and `paths:` (a YAML list).** Copilot reads the first, Claude Code the second. Each tool ignores the other's key, so both must be present and kept in sync. A file missing `paths:` gets loaded by Claude Code on *every* session instead of only when relevant.
- Use **one glob per rules file**. If an area needs two globs, split it into two files.
- **Subagent frontmatter uses Claude Code's vocabulary** for `tools:` (`Read, Glob, Grep, Bash, Edit, Write, …`) and `model:` (`opus`, `sonnet`, `haiku`), because Claude Code enforces those strictly while Copilot degrades gracefully on names it doesn't recognize. The `argument-hint`, `agents:` and `user-invocable:` keys are Copilot's and are ignored by Claude Code — harmless, so leave them.
- Keep personal permissions in `.claude/settings.local.json` (gitignored).
