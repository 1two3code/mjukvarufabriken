import styles from './ToastItem.module.css'

import { useTranslation } from 'react-i18next'

import { useEffectOnce } from '#/hooks/useEffectOnce.ts'

import { Button } from '#/components/Button.tsx'

import type { Toast, ToastType } from '#/features/toasts/toastsSlice.ts'

type ToastItemProps = {
	toast: Toast
	autoClose?: number
	close: (id: string) => void
}

export function ToastItem({ toast, autoClose = 8000, close }: ToastItemProps) {
	const { t } = useTranslation()

	useEffectOnce(() => {
		const timeoutId = window.setTimeout(() => close(toast.id), autoClose)
		return () => window.clearTimeout(timeoutId)
	})

	const typeClass: `${ToastType}Type` = `${toast.type}Type`
	const classNames = [styles.toast, styles[typeClass]]

	return (
		<div className={classNames.join(' ')} role="status">
			<div className={styles.messageText}>
				{toast.translate ? t(toast.message, toast.variables) : toast.message}
			</div>
			<Button size="tiny" color="secondary" onClick={() => close(toast.id)}>
				{t('common.action.close')}
			</Button>
			<div className={styles.progressBar} style={{ animationDuration: `${autoClose}ms` }} />
		</div>
	)
}
