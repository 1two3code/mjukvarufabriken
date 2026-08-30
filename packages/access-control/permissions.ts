/**
 * All available application permissions
 */
export const permissions = [
	// Spec permissions
	'spec:read',
	'spec:write',

	// Build job permissions
	'job:read',
	'job:write',
	'job:admin',

	// User permissions
	'user:all',
] as const

export type Permission = (typeof permissions)[number]
