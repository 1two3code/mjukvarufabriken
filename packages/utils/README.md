# @mf/utils

Pure utility functions shared between workspaces, exposed as subpath exports.

## Usage

```typescript
import { tryCatch } from '@mf/utils/function'
import { isObject, mergeDeep } from '@mf/utils/object'
import { addTime, isValidDate } from '@mf/utils/date'
```

Before adding a utility, make sure it is meant to be shared. Workspace-specific helpers belong in that workspace (`*.utils.ts`).
