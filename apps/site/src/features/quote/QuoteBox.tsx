import styles from './QuoteBox.module.css'

import { useTranslation } from 'react-i18next'

import { claimUrl } from '#/features/quote/quoteStorage.ts'

import { Button } from '#/components/Button.tsx'
import { ButtonLink } from '#/components/ButtonLink.tsx'

import type { Quote } from '@mf/models'
import type { QuoteHandle } from '#/features/quote/quoteStorage.ts'

type QuoteBoxProps = {
	quote: Quote
	handle: QuoteHandle
	onRestart: () => void
}

/**
 * The quote itself: the fixed price once the spec is complete, and the one door that needs a
 * login — "save / order this" hands the draft to the portal, which claims it after sign-in.
 */
export function QuoteBox({ quote, handle, onRestart }: QuoteBoxProps) {
	const { t, i18n } = useTranslation()
	const fixed = quote.complete && quote.priceSek !== undefined

	return (
		<section className={[styles.box, fixed ? styles.fixed : ''].join(' ')}>
			<h2 className={styles.title}>{t('quote.box.title')}</h2>
			{fixed ? (
				<>
					<p className={styles.label}>{t('quote.box.fixed')}</p>
					<p className={styles.price}>
						{t('quote.box.price', { price: quote.priceSek!.toLocaleString(i18n.language) })}
					</p>
					{quote.sizeClass && (
						<p className={styles.size}>{t('quote.box.sizeClass', { size: quote.sizeClass })}</p>
					)}
					<p className={styles.terms}>{t('quote.box.terms')}</p>
				</>
			) : (
				<p className={styles.pending}>{t('quote.box.pending')}</p>
			)}
			<div className={styles.actions}>
				<ButtonLink href={claimUrl(handle)} color={fixed ? 'primary' : 'secondary'}>
					{fixed ? t('quote.action.order') : t('quote.action.save')}
				</ButtonLink>
				<Button color="secondary" size="small" onClick={onRestart}>
					{t('quote.action.restart')}
				</Button>
			</div>
			<p className={styles.hint}>{t('quote.action.saveHint')}</p>
		</section>
	)
}
