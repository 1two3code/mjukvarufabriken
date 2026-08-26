// MARK: Colors
export const appColors = ['primary', 'secondary', 'danger'] as const

export type AppColors = (typeof appColors)[number]
