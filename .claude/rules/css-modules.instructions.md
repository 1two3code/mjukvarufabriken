---
description: "Use when writing or modifying CSS Module files in apps/app/src/. Covers camelCase class naming, CSS custom properties for design tokens, nesting, and variant/state class patterns."
applyTo: "apps/app/src/**/*.css"
paths:
  - "apps/app/src/**/*.css"
---

# CSS Module Conventions

## Class naming

Use **camelCase** for all class names. Variant classes should match the prop value directly so they can be accessed via `styles[variant]`.

```css
/* Size variants */
.tiny { --size: 2.4rem; }
.small { --size: 4rem; }
.default { --size: 4.8rem; }
.large { --size: 6rem; }

/* State classes */
.disabled { }
.hasValue { }
.iconTrailing { }
```

## Design tokens

Use CSS custom properties from the theme for colors, spacing, and typography.

```css
.primary {
  color: var(--primary-button-text-color);
  background: var(--primary-button-color);
}

.tiny {
  --font-size: var(--font-size-xs);
  --padding: var(--border-radius-xs);
}
```

## Nesting

Only use `&` for element states and or pseudo selectors:

```css
.primary {
  background: var(--primary-button-color);

  &:hover {
    background: var(--primary-button-hover-color);
  }
}
```

## Section organization

Use `/* MARK: Section Name */` comments to organize longer files:

```css
/* MARK: Layout */
.container { }

/* MARK: Variants */
.inline { }
.floating { }
```
