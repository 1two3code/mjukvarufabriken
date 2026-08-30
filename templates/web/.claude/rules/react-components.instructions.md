---
description: "Use when writing or modifying shared React components in apps/app/src/components/. Covers CSS Module co-location, prop typing, sub-component exports, generics, floating UI, and animation."
applyTo: "apps/app/src/components/**/*.tsx"
paths:
  - "apps/app/src/components/**/*.tsx"
---

# Shared Component Conventions

## File co-location

Each component has a paired CSS Module: `Component.tsx` + `Component.module.css` in the same directory. 

## Sub-component exports

Multiple related sub-components can be exported from the same file (e.g. `Modal`, `ModalContent`, `ModalFooter`). Each gets its own inline props type.

## Props

- Accept `className?: string` for external composability.
- Import shared types from `#/app/types.ts` (e.g. `AppColors`).
- Use string-union `type` aliases for variant/size props.

```typescript
import type { AppColors } from '#/app/types.ts'

type ButtonProps = {
  className?: string
  color?: AppColors
  size?: 'tiny' | 'small' | 'default' | 'large'
  children?: React.ReactNode
  onClick?: (event: React.MouseEvent<HTMLElement>) => void
}

export function Button({ className, color = 'primary', size = 'default', ...rest }: ButtonProps) {
  const classNames = [styles.button, styles[size], styles[color]]
  if (className) classNames.push(className)
  return <button className={classNames.join(' ')} {...rest} />
}
```

- When extending or consuming another component's props, use `ComponentProps<typeof Component>` from React — never export or import a component's props type directly.

```typescript
import type { ComponentProps } from 'react'

type CountryCodeSelectProps = { value: string | undefined } & Omit<
	ComponentProps<typeof Select<string>>,
	'label' | 'options' | 'value'
>
```

## Generic components

Use a generic type parameter when the component needs to handle multiple value types (e.g. selects, tables). Constrain the generic to the expected shape.

```typescript
type SelectProps<T> = InputProps<T> & {
  options?: { value: T; label: string }[]
  searchable?: boolean
}

export function Select<T extends string | undefined>({ options = [], ...rest }: SelectProps<T>) {
  // ...
}
```

## Floating UI

Use `@floating-ui/react` for dropdowns, selects, and popover-like components. Use `useFloating`, `useDismiss`, and `useInteractions` for positioning and lifecycle.

## Animation

Use `motion/react` (`AnimatePresence`, `motion.div`) for enter/exit transitions in overlay components like `Modal`.

## Dependency direction

Components must not import from `#/features/`. The dependency flows one way: features → components.
