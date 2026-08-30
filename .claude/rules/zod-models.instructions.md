---
description: "Use when writing or modifying Zod schemas in packages/models/schemas/. Covers schema naming, type inference, discriminated unions, .api.ts mutation/query/operation files, type guards."
applyTo: "packages/models/schemas/**/*.ts"
paths:
  - "packages/models/schemas/**/*.ts"
---

# Zod Model Conventions

## Schema naming

- Domain schemas: `EntitySchema` (e.g. `ItemSchema`, `UserSchema`)
- Enums/literals: lowercase camelCase (e.g. `itemStatus`, `role`)
- Always export both the schema and the inferred type:

```typescript
export const UserSchema = z.object({ id: z.string(), name: z.string() })
export type User = z.infer<typeof UserSchema>
```

## Composition

- `.extend()` for variants, `.pick()` for subsets, `.omit()` for exclusion, `.partial()` for update payloads.
- `z.discriminatedUnion('type', [VariantA, VariantB])` for polymorphic types.
- `Raw*Schema` for backend data → enriched `*Schema` for application use with added fields.

```typescript
export const RawItemSchema = z.object({ id: z.string(), name: z.string() })
export const ItemSchema = RawItemSchema.extend({ displayName: z.string().optional() })
```

## API files (`*.api.ts`)

Use `.api.ts` companion files to define API-layer schemas (request bodies, query params, and response shapes) for a given model entity. These are separate from the core domain schema and represent the contract between the API and its consumers.

Organize by MARK comment sections. Use a schemas object + a type map:

```typescript
// MARK: Mutations
export const UserMutationSchemas = {
  CreateUser: UserSchema.omit({ meta: true }).required().strict(),
  UpdateUser: UserSchema.pick({ name: true, role: true }).partial(),
}

export type UserMutation = {
  CreateUser: z.infer<typeof UserMutationSchemas.CreateUser>
  UpdateUser: z.infer<typeof UserMutationSchemas.UpdateUser>
}

// MARK: Queries
// MARK: Operations
// MARK: Custom responses
```

## Type guards

Name type guard functions with an `is*` prefix and a return type predicate. Place guards in companion `.guards.ts` files in `packages/models/schemas/`.

```typescript
export const isArchivedItem = (item: unknown): item is ArchivedItem => {
  return isItem(item) && item.status === 'archived'
}
```

## Barrel export

All schemas are re-exported from `packages/models/index.ts` via `export * from './schemas/Entity.ts'`.
