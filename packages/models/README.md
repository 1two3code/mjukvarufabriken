# @template/models

Entity models shared between the app and the api, built with [Zod](https://zod.dev).

## Usage

```typescript
import { ItemSchema } from '@template/models'
import type { Item } from '@template/models'
```

## Layout

- `schemas/Entity.ts` — the domain schema and its inferred type.
- `schemas/Entity.api.ts` — API-layer mutation/query/operation schemas.
- `schemas/Entity.guards.ts` — `is*` type guards.
- `index.ts` — barrel; every schema file is re-exported from here.
