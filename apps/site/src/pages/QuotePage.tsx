import styles from './QuotePage.module.css'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { skipToken } from '@reduxjs/toolkit/query'

import { isApiError } from '#/app/api.ts'
import { usePageMeta } from '#/hooks/usePageMeta.ts'
import {
	useCreateQuoteMutation,
	useGetQuoteQuery,
	usePostQuoteMessageMutation,
} from '#/features/quote/quoteApiSlice.ts'
import {
	clearQuoteHandle,
	readQuoteHandle,
	writeQuoteHandle,
} from '#/features/quote/quoteStorage.ts'
import { QuoteBox } from '#/features/quote/QuoteBox.tsx'
import { QuoteChat } from '#/features/quote/QuoteChat.tsx'
import { QuotePreview } from '#/features/quote/QuotePreview.tsx'

import { Button } from '#/components/Button.tsx'
import { Section } from '#/components/Section.tsx'
import { Spinner } from '#/components/Spinner.tsx'

import type { QuoteHandle } from '#/features/quote/quoteStorage.ts'

/**
 * The free spec chat with no login (wave 14, F1). Nothing is fetched until the visitor writes
 * the first message — that message creates the anonymous quote, whose handle is kept in
 * localStorage so a refresh resumes the draft. Login is only for saving or ordering it.
 */
export function QuotePage() {
	const { t } = useTranslation()
	usePageMeta('meta.quote.title', 'meta.quote.description')

	const [handle, setHandle] = useState<QuoteHandle | null>(readQuoteHandle)
	const { data: quote, isLoading, isError, error, refetch } = useGetQuoteQuery(handle ?? skipToken)
	const [createQuote, { isLoading: isCreating }] = useCreateQuoteMutation()
	const [postMessage, { isLoading: isPosting }] = usePostQuoteMessageMutation()

	const restart = () => {
		clearQuoteHandle()
		setHandle(null)
	}

	// Only the api's 404 means the stored handle is dead (claimed, swept, wrong origin): offer a
	// fresh start. Anything else — a 429 read window shared by a NAT, a 5xx, a network blip — is
	// transient: the draft is still there, so keep the handle and offer a retry instead
	const stale = handle !== null && isError && isApiError(error) && error.status === 404
	const unreachable = handle !== null && isError && !stale

	/** The first message mints the quote; every message is one engine turn. True when sent. */
	const send = async (content: string) => {
		let current = stale ? null : handle
		if (!current) {
			const created = await createQuote({ name: t('quote.orderName') })
			if (created.error) return false
			current = { orderId: created.data.quote.orderId, token: created.data.token }
			writeQuoteHandle(current)
			setHandle(current)
		}
		const result = await postMessage({ ...current, content })
		return !result.error
	}

	return (
		<>
			<Section eyebrow={t('quote.eyebrow')} lead={t('quote.lead')}>
				<h1>{t('quote.title')}</h1>
			</Section>

			{stale && (
				<Section variant="card">
					<p className={styles.stale} role="status">
						{t('quote.resume.failed')}
					</p>
					<div>
						<Button color="secondary" size="small" onClick={restart}>
							{t('quote.action.restart')}
						</Button>
					</div>
				</Section>
			)}

			{unreachable && (
				<Section variant="card">
					<p className={styles.stale} role="status">
						{t('quote.resume.retry')}
					</p>
					<div>
						<Button color="secondary" size="small" onClick={() => void refetch()}>
							{t('quote.action.retry')}
						</Button>
					</div>
				</Section>
			)}

			{isLoading ? (
				<Spinner center />
			) : (
				<div className={styles.layout}>
					<QuoteChat
						quote={stale ? undefined : quote}
						isSending={isCreating || isPosting}
						onSend={send}
					/>
					{quote && handle && !stale && (
						<aside className={styles.side}>
							<QuoteBox quote={quote} handle={handle} onRestart={restart} />
							<QuotePreview quote={quote} />
						</aside>
					)}
				</div>
			)}
		</>
	)
}
