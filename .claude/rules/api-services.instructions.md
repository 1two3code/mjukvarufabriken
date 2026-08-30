---
description: "Use when writing or modifying Fastify services under apps/api/src/services/. Covers service plugin pattern, naming conventions for .types.ts and .utils.ts companion files, fp() registration, and mock structure."
applyTo: "apps/api/src/services/**/*.ts"
paths:
  - "apps/api/src/services/**/*.ts"
---

# Fastify Service Conventions

Services contain **business logic**. They follow the same `fastify-plugin` scaffolding as plugins but are concerned with domain operations rather than infrastructure.

## Service skeleton

```typescript
import fp from 'fastify-plugin'

import type { FastifyPluginAsync } from 'fastify'

declare module 'fastify' {
  interface FastifyInstance {
    entityService: {
      get: (id: string) => Promise<Entity>
      find: () => Promise<Entity[]>
    }
  }
}

const plugin: FastifyPluginAsync = async app => {
  const { store, secrets } = app

  app.decorate('entityService', {
    get: async id => { /* ... */ },
    find: async () => { /* ... */ },
  })
}

export default fp(plugin, {
  name: '#internal/entityService',
  dependencies: ['#internal/store', '#internal/secrets'],
})
```

- Default export is required for autoload.
- Name format: `#internal/camelCaseServiceName`.
- Services can have **nested method groups** (e.g. `catalogService.item.find()`, `catalogService.category.get()`) if it helps organize related functionality. In that case, the service interface and implementation would reflect the nested structure.

## Companion files

| File | Purpose |
|------|---------|
| `*.types.ts` | Method signatures, internal type aliases |
| `*.utils.ts` | Pure helper functions used by the service |
| `__mocks__/*.ts` | Test mock implementations |

## Mock pattern

Mocks use the same `fp()` wrapper and `name`. Type the mock as `FastifyInstance['serviceName']`.

```typescript
export const createMockEntity = (overrides?: PartialDeep<MockEntity>) =>
	mergeDeep(mockEntity, overrides)

const mockPlugin: FastifyPluginAsync = async app => {
  const mock: FastifyInstance['entityService'] = {
    get: vi.fn().mockResolvedValue({ id: '1' }),
    find: vi.fn().mockResolvedValue([]),
  }
  app.decorate('entityService', mock)
}

export default fp(mockPlugin, { name: '#internal/entityService' })
```
