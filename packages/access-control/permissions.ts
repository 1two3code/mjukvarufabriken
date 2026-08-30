/**
 * All available application permissions
 */
export const permissions = [
	// Item permissions
	'item:read',
	'item:write',
	'item:delete',

	// User permissions
	'user:all',
] as const

export type Permission = (typeof permissions)[number]
