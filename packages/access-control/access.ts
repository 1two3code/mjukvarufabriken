import type { Permission } from './permissions.ts'
import type { Role } from './role.ts'

export type Access = Record<Role, Permission[]>

/**
 * Defined application access control
 */
export const access: Access = {
	admin: ['spec:read', 'spec:write', 'job:read', 'job:write', 'job:admin', 'user:all'],
	user: ['spec:read', 'spec:write', 'job:read', 'job:write'],
} as const
