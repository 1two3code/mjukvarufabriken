import { access } from './access.ts'

import type { Permission } from './permissions.ts'
import type { Role } from './role.ts'

/**
 * Get all permissions for a given role
 */
export function getPermissions(role: Role): Permission[] {
	return access[role] ?? []
}

/**
 * Check if a role has a specific permission
 */
export function hasPermission(role: Role, permission: Permission): boolean {
	return getPermissions(role).includes(permission)
}

/**
 * Check if a role has one or more of the given permissions
 */
export function includesPermission(role: Role, permissions: Permission[]): boolean {
	return permissions.some(permission => hasPermission(role, permission))
}

/**
 * Check if a role has all of the given permissions
 */
export function includesAllPermissions(role: Role, permissions: Permission[]): boolean {
	return permissions.every(permission => hasPermission(role, permission))
}

/**
 * Get all system roles
 */
export function getAllRoles(): Role[] {
	return Object.keys(access) as Role[]
}
