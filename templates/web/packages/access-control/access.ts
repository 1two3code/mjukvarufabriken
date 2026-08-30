import type { Permission } from './permissions.ts'
import type { Role } from './role.ts'

export type Access = Record<Role, Permission[]>

/**
 * Defined application access control
 */
export const access: Access = {
	admin: ['item:read', 'item:write', 'item:delete', 'user:all'],
	user: ['item:read', 'item:write'],
} as const
