import { useAppDispatch } from '#/app/hooks.ts'
import { addToast } from '#/features/toasts/toastsSlice.ts'

import type { ToastType } from '#/features/toasts/toastsSlice.ts'

export type ToastHook = (type: ToastType, message: string, id?: string) => void

/**
 * Hook for displaying toast messages.
 */
export function useToast(): ToastHook {
	const dispatch = useAppDispatch()

	return (type, message, id = crypto.randomUUID()) => {
		dispatch(addToast({ type, message, id }))
	}
}
