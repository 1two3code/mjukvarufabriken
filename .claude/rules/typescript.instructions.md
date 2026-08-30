---
description: "Use when writing or modifying TypeScript code. Covers variable declarations, type imports, path aliases, helper function extraction, error handling, constants, naming, immutability, and section comments."
applyTo: "**/*.ts"
paths:
  - "**/*.ts"
---

# TypeScript Conventions

- Favour `const` over `let`. Only use `let` when reassignment is truly required (e.g. conditional mutation, loop accumulation).

## Imports
- **No relative parent imports**: use the `#/` path alias instead of `../`. 

```typescript
// Correct
import { EntityNotFound } from '#/lib/entityError.ts'
```

```typescript
// Avoid
import { EntityNotFound } from '../../lib/entityError.ts'  // relative parent
```

## Error handling

Use `tryCatch()` / `tryCatchSync()` from `@template/utils/function` when you need to **inspect or handle the specific error**. The tuple `[error, result]` pattern keeps the happy path at the top indentation level.

```typescript
import { tryCatch } from '@template/utils/function'

const [error, item] = await tryCatch(itemService.get(request.params.id))
if (error) return reply.error(error instanceof EntityNotFound ? 404 : 500, error)
```

When you don't care about the specific error and just need a **catch-all**, a plain `try/catch` block is fine.

```typescript
try {
  await doSomething()
} catch {
  return reply.error(500, 'Unexpected error')
}
```

For domain errors, use the custom error classes from `#/lib/entityError.ts`:

```typescript
import { EntityNotFound, EntityInvalid } from '#/lib/entityError.ts'

throw new EntityNotFound('item', id)
throw new EntityInvalid('item', id)
```

## Constants

Use `as const` objects or arrays for string-literal sets — never TypeScript `enum`. Derive the union type from the constant.

```typescript
// Object constant → union from values
export const role = {
  admin: 'admin',
  user: 'user',
} as const

export type Role = (typeof role)[keyof typeof role]

// Array constant → union from elements
export const permissions = ['item:read', 'item:write', 'user:all'] as const

export type Permission = (typeof permissions)[number]
```

## Naming conventions

- **Files**: camelCase (`itemService.ts`, `entityError.ts`).
- **Companion files**: `.types.ts` for type definitions, `.utils.ts` for helpers.
- **Functions**: `is*` for predicates, `validate*` for validators.
- **Types**: PascalCase (`Permission`, `Role`, `ItemStatus`).

## Immutability

Use `structuredClone()` for deep copies before mutation. Never mutate function arguments directly.

```typescript
const raw = structuredClone(entry)
transformRuntimeToRaw(raw)
return raw
```

## Section comments

Use `// MARK:` comments to delimit logical sections within longer files.

```typescript
// MARK: Mutations
// MARK: Queries
// MARK: Validations
```

## Helper functions

When a block of logic requires **more than one line**, extract it into a named helper function. Keep single-line expressions inline.

```typescript
// Correct — multi-line logic extracted into a helper
const filterByStatus = (items: Item[], status: ItemStatus) => {
  const matching = items.filter(item => item.status === status)
  return matching.toSorted((a, b) => a.name.localeCompare(b.name))
}

const items = await itemService.find()
const activeItems = status ? filterByStatus(items, status) : items
```

```typescript
// Avoid — multi-line logic inlined
const items = await itemService.find()
if (status) {
  const matching = items.filter(item => item.status === status)
  const activeItems = matching.toSorted((a, b) => a.name.localeCompare(b.name))
}
```
