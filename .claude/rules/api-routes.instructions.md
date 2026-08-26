---
description: "Use when writing or modifying API route handlers under apps/api/src/routes/. Covers route file structure, Zod schema validation, error handling, logic placement, reply.error conventions, and default export for auto-loading."
applyTo: "apps/api/src/routes/**/*.ts"
paths:
  - "apps/api/src/routes/**/*.ts"
---

# API Route Conventions

## Route file structure

Route files export a default `FastifyPluginAsyncZod` function. Define a `schema` object and pass it to the route registration. The `response` schema is required — it defines the contract the route returns. Add `params`, `querystring`, and/or `body` only when the route needs them.

```typescript
import { z } from 'zod'
import { UserSchema } from '@mf/models'

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'

const schema = {
  params: z.object({ id: z.string() }),
  response: { 200: UserSchema },
}

const route: FastifyPluginAsyncZod = async function (app) {
  app.get('/bff/items/:id', { schema }, async (request, reply) => {
    const { session, params } = request
    // ...
  })
}

export default route
```

- Use `export default route` — route files require a default export for Fastify autoload.
- Destructure `request` to access `session`, `params`, `query`, `body` as needed.

## Logic placement

Prefer implementing logic directly in the route file rather than extracting it into a service. Only move logic to a service when the functionality needs to be reused across multiple routes.

When route handler logic grows complex, extract it into **named helper functions** within the same file. Where the function lives depends on whether it needs access to Fastify instance resources (decorated plugins and services available via `app`):

- **Needs `app` access** (e.g. `app.itemService`, `app.secrets`, `app.store`) — define the helper **inside the route plugin function** (`async function (app) { ... }`) but outside the individual handler. This gives the helper access to `app` without having to receive it as a parameter.
- **Needs no `app` access** (pure logic, data transformation, query building) — define the helper **at module level**, outside the plugin function entirely.

```typescript
// Module-level helper — no Fastify resources needed
const buildFilter = (query: ItemQuery['GetItems']) => ({
  status: query.status,
  search: query.search?.trim().toLowerCase(),
})

const route: FastifyPluginAsyncZod = async function (app) {
  // Plugin-scoped helper — needs app.itemService
  const getItemOrNull = async (id: string) => {
    const [error, item] = await tryCatch(app.itemService.get(id))
    if (error) return null
    return item
  }

  app.get('/bff/items/:id', { schema }, async (request, reply) => {
    const { params, query } = request
    const filter = buildFilter(query)
    const item = await getItemOrNull(params.id)
    if (!item) return reply.error(404, new EntityNotFound('item', params.id))
    return reply.send(item)
  })
}

export default route
```

## Error handling

- When a route has a **single error path**, use a plain `try/catch` block instead of the `tryCatch()` utility:

```typescript
try {
  const user = await userService.get(id)
  return reply.send(user)
} catch (error) {
  return reply.error(500, error as Error)
}
```

- Only use `tryCatch()` when the route needs to **differentiate between multiple errors** with distinct status codes or handling:

```typescript
const [itemError, item] = await tryCatch(itemService.get(id))
if (itemError) return reply.error(itemError instanceof EntityNotFound ? 404 : 500, itemError)

const [updateError] = await tryCatch(itemService.update(id, body))
if (updateError) return reply.error(500, updateError, 'failedToUpdateItem')
```

## reply.error usage

Do **not** pass an error code (3rd argument) to `reply.error()` unless it is a message key that the frontend will use to provide a specific error message to the user when deemed appropriate. For generic server errors, omit the code and just pass the error object. 

The frontend should only implement specific handling for errors that are actionable. For all other errors, the frontend should treat them as generic errors and display a general error message.

```typescript
// Correct (default)
return reply.error(500, error as Error)

// Only when specific error handling is needed on the frontend.
return reply.error(500, error as Error, 'failedToUpdateItem')
```