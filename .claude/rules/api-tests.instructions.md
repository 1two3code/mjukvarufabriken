---
description: "Use when writing or modifying API tests under apps/api/test/. Covers createTestApp factory, networkMock MSW usage, inject() route testing, vi.spyOn mocking, and test file structure."
applyTo: "apps/api/test/**/*.ts"
paths:
  - "apps/api/test/**/*.ts"
---

# API Test Conventions

## Framework

Vitest with globals enabled. `describe`, `it`, `expect`, `vi`, `beforeAll`, `beforeEach`, `afterAll`, `afterEach` are available without imports.

## Test structure

```typescript
import route from '#/routes/bff/entity/getEntity.ts'

import type { FastifyInstance } from 'fastify'

describe('GET /bff/entity/:id route', () => {
  let app: FastifyInstance

  const entityId = 1000
  const url = `/bff/entity/${entityId}`
  beforeEach(async () => {
    app = await createTestApp()
    app.register(route)

    vi.spyOn(app.entityService, 'get').mockResolvedValue(
        createMockEntity({ id:  entityId })
    )
  })

  it('Returns entity by id', async () => {
    // Arrange
    // Act
    const response = await app.inject({ url })

    // Assert
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ id: entityId })
  })
  it('Handles unknown entity with 404 response', async () => {
    // Arrange
    vi.spyOn(app.entityService, 'get').mockRejectedValueOnce(new EntityNotFound('entity'))
    // Act
    const response = await app.inject({ url })
    // Assert
    expect(response.statusCode).toBe(404)
  })
})
```

- Test file path mirrors the source path: `test/routes/bff/entity/action.test.ts` → `src/routes/bff/entity/action.ts`.
- Follow the **AAA pattern**: Arrange (setup mocks) → Act (inject request) → Assert (status + body).

## createTestApp

Global factory — no import needed. All plugins and services are auto-mocked from `__mocks__/` directories.

- **Default**: `app = await createTestApp()` — everything mocked.
- **Skip mocks** to use real implementations: `await createTestApp({ skipMock: '#/services/itemService.ts' })`.
- **Skip multiple**: `{ skipMock: ['#/services/itemService.ts', '#/plugins/auth.ts'] }`.

## networkMock

Global MSW-based HTTP mock — no import needed.

```typescript
networkMock.get(app.secrets.authJwksUrl).reply(200, { keys: [] })
```

- Chainable for sequential responses: `.reply(200, first).reply(200, second)`.
- Spy assertions: `mock.spy.called(1)`, `mock.spy.requests`.
- Reset is automatic via `setupTests.ts` `afterEach`.

## Service mocking

### `createMock*` factory functions

`__mocks__/` files should export `createMock*` factory functions that produce typed fixture objects with sensible defaults. Use them to make the test **transparent** about what entity it operates on.

```typescript
// In __mocks__/ file
export const createMockItem = (overrides?: PartialDeep<Item>) =>
  mergeDeep(defaultItem, overrides)
```

```typescript
// In the test
let app: FastifyInstance
let item: Item

beforeEach(async () => {
  app = await createTestApp()
  app.register(route)

  item = createMockItem({ id: itemId })
  vi.spyOn(app.itemService, 'get').mockResolvedValue(item)
})
```

### When to override with `vi.spyOn`

Override in `beforeEach` or inside the individual `it` block when the test requires a specific return value, a rejection, or call-count assertions that the default fixture cannot provide:

```typescript
vi.spyOn(app.itemService, 'get').mockResolvedValue(item)
vi.spyOn(app.itemService, 'get').mockRejectedValueOnce(new EntityNotFound('item'))
```

- Use `.mockResolvedValue(x)` to override for every call in that test.
- Use `.mockResolvedValueOnce(x)` to override only the next call, then fall back to the default.
- Use `.mockRejectedValueOnce(err)` to simulate a service failure for one call.
- After `inject()`, assert spy calls with `expect(vi.mocked(app.itemService.get)).toHaveBeenCalledWith(...)`.
- **Prefer calling the mock to get its default fixture** and spread-override only the fields that differ, rather than writing a full inline object. This keeps tests coupled to the shared fixture and makes the intent explicit:

```typescript
// Preferred — only the differing field is declared in the test
const defaultItem = await app.itemService.get('item-1')
vi.spyOn(app.itemService, 'get').mockResolvedValue({ ...defaultItem, status: 'archived' })

// Avoid — duplicates fixture data already defined in the mock
vi.spyOn(app.itemService, 'get').mockResolvedValue({ id: 'item-1', name: 'Item', ... } as any)
```

### Mock method strategies (in `__mocks__/` files)

There are four strategies used across service mocks; choose the one that matches the method's test-time contract:

| Strategy | Example | Spy? | Per-call override? | Use when |
|---|---|---|---|---|
| Plain `async` function | `find: async term => term === 'X' ? [a] : []` | No | No | Deterministic branching logic is the right default and tests never need to assert the call happened |
| `vi.fn()` | `update: vi.fn()` | Yes | Yes | Method is rarely exercised in default flows; each test provides its own value via `.mockResolvedValue()` |
| `vi.fn().mockResolvedValue(x)` | `find: vi.fn().mockResolvedValue([item1])` | Yes | Yes | Method needs a sensible list/object default in most tests, but individual tests can still override |
| `vi.fn(arg => Promise.resolve(...))` | `get: vi.fn((id: string) => Promise.resolve(map[id] \|\| default))` | Yes | Yes | Return value must vary based on the argument (e.g. look up fixture by ID) |

**Guideline for new mocks**: prefer `vi.fn()` for mutation/write methods (nothing meaningful to return by default) and `vi.fn().mockResolvedValue(fixture)` for read methods that are called by most tests. Only use a plain `async` function when the branching logic is the authoritative fixture contract and call-count assertions are never needed.

## Service testing

Service tests verify **business logic**. Use `skipMock` for the service under test so its real implementation runs. Its dependencies (plugins, other services) remain auto-mocked.

```typescript
import type { FastifyInstance } from 'fastify'

describe('Entity Service', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = await createTestApp({ skipMock: '#/services/entityService.ts' })
  })

  it('Returns entity by id', async () => {
    // Arrange
    vi.spyOn(app.store, 'get').mockResolvedValue({ id: '1' })

    // Act
    const result = await app.entityService.get('1')

    // Assert
    expect(result).toEqual({ id: '1' })
  })
})
```

- Override dependency behavior with `vi.spyOn(app.dependency, 'method')`.
- Use `structuredClone()` when mutating mock objects for specific test cases.
- Test error paths by mocking rejections: `.mockRejectedValue(new Error('...'))`.

## Plugin testing

Plugin tests verify **HTTP client wrappers and external API interactions**. Use `skipMock` for the plugin under test so its real HTTP client runs. Intercept outgoing requests with `networkMock`.

```typescript
import type { FastifyInstance } from 'fastify'

describe('External API Plugin', () => {
  let app: FastifyInstance
  let baseUrl: string

  beforeEach(async () => {
    app = await createTestApp({ skipMock: '#/plugins/externalApi.ts' })
    baseUrl = app.secrets.externalApiUrl
  })

  it('Calls GET /items with correct query params', async () => {
    // Arrange
    networkMock.get(`${baseUrl}/items`, { searchParams: ['filter'] }).reply(200, { data: [] })

    // Act
    const result = await app.externalApi.items.search('query')

    // Assert
    expect(result).toEqual([])
  })
})
```

- Use `networkMock.get/post/put/patch(url, validity).reply(status, body)` to intercept HTTP.
- Validity options: `{ headers: [...], searchParams: [...], body: {...} }`.
- Use `spy.assert(req => ...)` to verify request details (e.g. uppercased params).

## Route testing with inject

```typescript
const response = await app.inject({
  method: 'POST',
  url: '/bff/items',
  payload: body,
  headers: { 'content-type': 'application/json' },
})

expect(response.statusCode).toBe(201)
expect(response.json()).toEqual({ id: expect.any(String) })
```
