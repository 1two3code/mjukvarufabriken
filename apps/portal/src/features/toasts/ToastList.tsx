import styles from './ToastList.module.css'

import { createPortal } from 'react-dom'

import { useAppDispatch, useAppSelector } from '#/app/hooks.ts'
import { removeToast, selectToasts } from '#/features/toasts/toastsSlice.ts'
import { ToastItem } from '#/features/toasts/ToastItem.tsx'

export function ToastList() {
	const dispatch = useAppDispatch()
	const toasts = useAppSelector(selectToasts)

	const close = (id: string) => {
		dispatch(removeToast({ id }))
	}

	return createPortal(
		<div className={styles.container}>
			{toasts.map(toast => (
				<ToastItem key={toast.id} toast={toast} close={close} />
			))}
		</div>,
		document.body
	)
}
