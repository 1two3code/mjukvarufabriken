---
description: "Use when writing or modifying React feature modules in apps/app/src/features/. Covers feature folder structure, Redux slice patterns, listener middleware, context files, filter pattern, forms, and API slice integration."
applyTo: "apps/app/src/features/**/*.tsx"
paths:
  - "apps/app/src/features/**/*.tsx"
---

# Feature Module Conventions

## State ownership

| Scope | Tool |
|---|---|
| Feature-local UI state (filters, selections, pagination, form steps) | React Context |
| App-wide shared state (auth, theme, language, toasts, modals) | Redux slice |
| Server data | RTK Query |

**Never use Redux for feature-local state.** If the state is only needed within a single feature, put it in a Context file co-located with that feature.

## Folder structure

Each feature is a self-contained folder under `features/`. Feature components can have paired CSS Modules just like shared components.

```
features/items/
  ├── itemsApiSlice.ts          # RTK Query endpoints (one per feature)
  ├── itemsSlice.ts             # Redux slice (if local state needed)
  ├── itemsListeners.ts         # Listener middleware (if side effects needed)
  ├── itemsFiltersContext.ts    # Context for filter state
  ├── ItemsTable.tsx            # Feature components
  ├── ItemsFilter.tsx
  ├── ItemsFilter.module.css
  └── wizard/                     # Sub-folders for complex UI
```

## Forms

When a feature needs a form, add a `useForm` hook under `#/hooks/useForm.ts` that provides `formData`, `formState` (errors, isDirty), `handleInputChange`, and `handleSubmit`, and use it from the feature (the template does not ship one).

```typescript
const { formData, formState: { errors, isDirty }, handleInputChange, handleSubmit } =
  useForm<ItemMutation['CreateItem']>({
    initialValues: structuredClone(data ?? {}),
    validation: {
      email: value => (!value || isEmail(value) ? null : t('error.form.invalid.email')),
    },
  })
```

## Context pattern

Use `createContext` for feature-local state. Co-locate the context file with the feature (i.e. `featureContext.ts`).

```typescript
import { createContext } from 'react'

import type { ItemsFilters } from '#/features/items/ItemsFilter.tsx'

export const ItemsFiltersContext = createContext<{
  areFiltersDirty: boolean
  defaultFilters: ItemsFilters
}>({ areFiltersDirty: false, defaultFilters: { page: 1 } })
```

## Redux slice pattern

Use a Redux slice for **app-wide** state that must be shared across features. Do not use Redux for state that is only relevant inside a single feature.

```typescript
export const entitySlice = createSlice({
  name: 'entity',
  initialState: { /* ... */ },
  selectors: {
    selectEntity: state => state.entity,
  },
  reducers: create => ({
    setEntity: create.reducer((state, action: PayloadAction<Entity>) => {
      state.entity = action.payload
    }),
  }),
})

export const { setEntity } = entitySlice.actions
export const { selectEntity } = entitySlice.selectors
```

## Listener middleware

```typescript
const listener = createListenerMiddleware()
const registerListener = listener.startListening.withTypes<RootState, AppDispatch>()

registerListener({
  actionCreator: setTokens,
  effect: async (action, api) => {
    localStorage.setItem('token', action.payload.token)
  },
})

export const entityListenerMiddleware = listener.middleware
```

## Store registration

- New slices: add to `combineSlices()` in `store.ts`.
- New listener middleware: prepend in the `middleware` chain in `store.ts`.
