---
description: "Use when writing or modifying RTK Query API slices in apps/app/src/features/. Covers appApi.enhanceEndpoints, injectEndpoints, tag-based caching, queryFn, optimistic updates, and hook exports."
applyTo: "apps/app/src/features/**/*ApiSlice.ts"
paths:
  - "apps/app/src/features/**/*ApiSlice.ts"
---

# RTK Query API Slice Conventions

## Base API

Never create a new `createApi()` instance. Import the shared `appApi` from `#/app/api.ts`.

## Slice structure

```typescript
import { appApi } from '#/app/api.ts'

import type { Entity, EntityMutation } from '@template/models'

export const entityApiSlice = appApi
  .enhanceEndpoints({ addTagTypes: ['entity'] })
  .injectEndpoints({
    endpoints: build => ({
      getEntity: build.query<Entity, string>({
        query: id => `/entity/${id}`,
        providesTags: (_result, _error, id) => [{ type: 'entity', id }],
      }),
      createEntity: build.mutation<{ id: string }, EntityMutation['Create']>({
        query: body => ({ url: '/entity', method: 'POST', body }),
        invalidatesTags: ['entity'],
      }),
    }),
  })

export const { useGetEntityQuery, useCreateEntityMutation } = entityApiSlice
```

## Tag patterns

- **List-level**: `providesTags: ['entity']` — invalidates entire list.
- **Item-level**: `providesTags: (_r, _e, { id }) => [{ type: 'entity', id }]` — granular.
- **Invalidation**: `invalidatesTags: ['entity']` or `[{ type: 'entity', id }]`.

## Cache control

Use `ApiCaching` from `#/app/api.ts`:

- `keepUnusedDataFor: ApiCaching.none` — 1 second (no cache)
- `keepUnusedDataFor: ApiCaching.default` — 120 seconds (default, can omit)
- `keepUnusedDataFor: ApiCaching.long` — 8 hours (static data)

## Complex queries

Use `queryFn` when you need `api.dispatch` access or multi-step logic:

```typescript
getEntities: build.query({
  queryFn: async (query, api, _extraOptions, baseQuery) => {
    const result = await baseQuery({ url: '/entities', params: query })
    return { data: result.data as Entity[] }
  },
})
```

## Optimistic updates

Use `onQueryStarted` to apply optimistic cache patches before the server responds. Always undo the patch if the request fails.

```typescript
updateItem: build.mutation<void, { id: string; optimistic?: boolean } & ItemMutation['UpdateItem']>({
  query: ({ id, optimistic, ...body }) => ({ url: `/items/${id}`, method: 'PATCH', body }),
  async onQueryStarted({ id, optimistic = false, ...updates }, { dispatch, queryFulfilled }) {
    if (!optimistic) return
    const patch = dispatch(
      itemsApiSlice.util.updateQueryData('getItem', id, draft => {
        Object.assign(draft, updates)
      })
    )
    queryFulfilled.catch(() => patch.undo())
  },
  invalidatesTags: (_result, _error, { id }) => [{ type: 'items', id }],
}),
```

Key rules:
- Guard with an `optimistic` flag so callers opt in explicitly.
- Always call `patch.undo()` in the `.catch()` of `queryFulfilled`.
- The real server response will replace the optimistic data once `invalidatesTags` triggers a refetch.
