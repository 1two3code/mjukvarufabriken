# @template/utils

Pure utility functions shared between workspaces, exposed as subpath exports.

## Usage

```typescript
import { tryCatch } from '@template/utils/function'
import { isObject, mergeDeep } from '@template/utils/object'
import { addTime, isValidDate } from '@template/utils/date'
```

Before adding a utility, make sure it is meant to be shared. Workspace-specific helpers belong in that workspace (`*.utils.ts`).
