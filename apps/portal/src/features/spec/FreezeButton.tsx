import styles from './FreezeButton.module.css'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isSpecComplete } from '@mf/models'

import { useToast } from '#/hooks/useToast.ts'
import { useFreezeSpecMutation } from '#/features/spec/specApiSlice.ts'

import { Button } from '#/components/Button.tsx'

import type { SpecDraft } from '@mf/models'

type FreezeButtonProps = {
	draft: SpecDraft
}

export function FreezeButton({ draft }: FreezeButtonProps) {
	const { t, i18n } = useTranslation()
	const toast = useToast()
	const [freeze, { isLoading }] = useFreezeSpecMutation()
	const [confirming, setConfirming] = useState(false)

	const complete = isSpecComplete(draft.spec)

	if (draft.status === 'frozen') {
		return (
			<div className={styles.frozen}>
				<strong>{t('spec.freeze.frozenTitle')}</strong>
				<span>
					{t('spec.freeze.frozenBody', {
						date: draft.frozenAt ? new Date(draft.frozenAt).toLocaleString(i18n.language) : '',
						price: draft.priceSek?.toLocaleString(i18n.language) ?? '',
					})}
				</span>
			</div>
		)
	}

	const handleConfirm = async () => {
		const result = await freeze(draft.orderId)
		setConfirming(false)
		if (!result.error) toast('success', t('spec.freeze.toast.frozen'))
	}

	if (confirming) {
		return (
			<div className={styles.confirm} role="alertdialog" aria-label={t('spec.freeze.confirmTitle')}>
				<strong>{t('spec.freeze.confirmTitle')}</strong>
				<p className={styles.confirmBody}>
					{t('spec.freeze.confirmBody', {
						price: draft.priceSek?.toLocaleString(i18n.language) ?? '',
					})}
				</p>
				<div className={styles.actions}>
					<Button
						color="secondary"
						size="small"
						disabled={isLoading}
						onClick={() => setConfirming(false)}
					>
						{t('common.action.cancel')}
					</Button>
					<Button size="small" disabled={isLoading} onClick={handleConfirm}>
						{t('spec.freeze.action.confirm')}
					</Button>
				</div>
			</div>
		)
	}

	return (
		<div className={styles.wrapper}>
			<Button disabled={!complete || isLoading} onClick={() => setConfirming(true)}>
				{t('spec.freeze.action.freeze')}
			</Button>
			{!complete && <span className={styles.hint}>{t('spec.freeze.hintIncomplete')}</span>}
		</div>
	)
}
