/**
 * All available application roles
 */
export const role = {
	admin: 'admin',
	user: 'user',
} as const

export type Role = (typeof role)[keyof typeof role]
