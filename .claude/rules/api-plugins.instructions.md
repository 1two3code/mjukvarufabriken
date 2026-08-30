---
description: "Use when writing or modifying Fastify plugins under apps/api/src/plugins/. Covers plugin scaffolding, module augmentation, app.decorate, fp() registration, and onClose hooks."
applyTo: "apps/api/src/plugins/**/*.ts"
paths:
  - "apps/api/src/plugins/**/*.ts"
---

# Fastify Plugin Conventions

## Plugin skeleton

Every plugin uses `fastify-plugin`, is typed as `FastifyPluginAsync`, and is always async.

```typescript
import fp from 'fastify-plugin'

import type { FastifyPluginAsync } from 'fastify'

declare module 'fastify' {
  interface FastifyInstance {
    pluginName: { /* methods */ }
  }
}

const plugin: FastifyPluginAsync = async app => {
  app.decorate('pluginName', { /* methods */ })
}

export default fp(plugin, { name: '#internal/pluginName' })
```

## Module augmentation

Use `declare module 'fastify'` to augment the appropriate interface:

- **`FastifyInstance`** — for `app.decorate()` (most plugins)
- **`FastifyRequest`** — for `app.decorateRequest()` (e.g. auth tokens)
- **`FastifyReply`** — for `app.decorateReply()` (e.g. error helper)
- **`FastifyContextConfig`** — for route-level config (e.g. permissions)

## Registration

- Export: `export default fp(plugin, { name, dependencies })` — default export is required for autoload.
- Name format: `#internal/camelCaseName` (e.g. `#internal/objectStorage`).
- Dependencies: list other `#internal/*` names the plugin depends on.

```typescript
export default fp(plugin, {
  name: '#internal/store',
  dependencies: ['#internal/secrets'],
})
```

## Cleanup hooks

Add `app.addHook('onClose', ...)` for clients that need explicit teardown (database connections, AWS SDK clients, message consumers). Plain `fetch`-based HTTP clients do **not** need cleanup.

```typescript
app.addHook('onClose', () => client.destroy())
```
