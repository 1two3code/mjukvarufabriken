---
description: "Use when writing or modifying React components in apps/app/src. Covers React Compiler baseline, Effects rules, import ordering, CSS class composition, exports, props, Redux hooks, routing, context, and translations."
applyTo: "apps/app/src/**/*.tsx"
paths:
  - "apps/app/src/**/*.tsx"
---

# React TSX Baseline

- Assume React Compiler is already enabled for the app build pipeline.
- Assume the project runs on the latest React version in use by the repository.
- Do not add compatibility guidance for older React versions unless the user explicitly asks for backward compatibility.

# Coding Guidance

- Prefer compiler-friendly, pure render logic.
- Do **not** add `useMemo`, `useCallback`, or `React.memo` to new code — React Compiler handles memoization automatically and more precisely than manual annotations.
- For existing memoization, leave it in place unless you have verified it is safe to remove.

## Effects

Effects are an escape hatch for synchronizing with external systems. Follow these rules:

- **Do not use Effects to transform data for rendering.** Derive values directly during render instead. An Effect that sets state immediately after render causes two render passes.

- **Do not use Effects to handle user events.** Put that logic in the event handler where the interaction is clear.

- **Do not chain Effects** to synchronize state with other state. Calculate derived state during rendering or consolidate updates inside the event handler.

- **Do not pass data up to a parent via an Effect.** Lift the data fetch to the parent and pass it down as props or by defining a `Context`.


## SVG icons

Import SVGs as React components using the Vite `?react` suffix:

```typescript
import ArrowIcon from '#/assets/icons/arrow-down.svg?react'
```

## CSS class composition

Build class lists as arrays and join them. Use `styles[value]` for variant classes matching a prop value.

```typescript
const classNames = [styles.button, styles[size], styles[color]]
if (className) classNames.push(className)
if (disabled) classNames.push(styles.disabled)
return <button className={classNames.join(' ')} />
```

## Exports

- Use **named function exports**: `export function ComponentName() {}`. Never use default exports.

## Props

- Define props as an inline `type` above the component.

## Redux hooks

- Import pre-typed hooks from `#/app/hooks.ts` — never import raw `useSelector`, `useDispatch`, or `useStore` from `react-redux`.

```typescript
import { useAppSelector, useAppDispatch } from '#/app/hooks.ts'
```

## Context

- Consume context with React 19's `use()` — not the legacy `useContext()` hook.

```typescript
import { use } from 'react'
import { ItemsContext } from '#/features/items/itemsContext.ts'

const { selectedId, setSelectedId } = use(ItemsContext)
```

## Routing

- Use hooks from `react-router-dom`: `useNavigate`, `useParams`, `useSearchParams`.
- Use `navigate()` for programmatic navigation inside event handlers.

## Translations

- Use `useTranslation()` from `react-i18next` and `t('key')` for user-facing text. Translations are stored in `apps/app/public/locales/<lang>.json`; add new keys to every locale file (`en.json` is the source of truth).