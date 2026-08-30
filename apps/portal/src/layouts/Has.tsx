import { usePermission } from '#/hooks/usePermission.ts'

import type { Permission } from '@mf/access-control'

type HasProps = {
	permissions: Permission[]
	children: React.ReactNode
	/**
	 * If true, the session needs to have at least one of the permissions
	 */
	anyOf?: boolean
}

export function Has({ permissions, children, anyOf = false }: HasProps) {
	const { hasPermission } = usePermission()

	const isAllowed = anyOf
		? permissions.some(permission => hasPermission(permission))
		: permissions.every(permission => hasPermission(permission))

	return isAllowed ? <>{children}</> : null
}
