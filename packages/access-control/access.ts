import type { Permission } from './permissions.ts'
import type { Role } from './role.ts'

export type Access = Record<Role, Permission[]>

/**
 * Defined application access control
 */
export const access: Access = {
	admin: ['item:read', 'item:write', 'item:delete', 'spec:read', 'spec:write', 'user:all'],
	user: ['item:read', 'item:write', 'spec:read', 'spec:write'],
} as const
