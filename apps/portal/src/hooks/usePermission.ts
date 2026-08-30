import { getPermissions, hasPermission } from '@mf/access-control'

import { useAppSelector } from '#/app/hooks.ts'
import { selectSession } from '#/features/session/sessionSlice.ts'

import type { Permission } from '@mf/access-control'

/**
 * Hook to verify session permissions.
 */
export function usePermission() {
	const { role } = useAppSelector(selectSession)

	return {
		hasPermission: (permission: Permission) => hasPermission(role, permission),
		getPermissions: () => getPermissions(role),
	}
}
