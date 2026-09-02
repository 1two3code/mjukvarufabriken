import styles from './QuoteChat.module.css'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '#/components/Button.tsx'
import { Spinner } from '#/components/Spinner.tsx'

import type { Quote } from '@mf/models'

type QuoteChatProps = {
	/** Absent until the visitor's first message creates the quote */
	quote?: Quote
	isSending: boolean
	onSend: (content: string) => Promise<boolean>
}

/**
 * The site's port of the portal's spec chat (same copy, the site's own Button/Spinner). The
 * page owns the api calls: the first message also creates the anonymous quote.
 */
export function QuoteChat({ quote, isSending, onSend }: QuoteChatProps) {
	const { t } = useTranslation()
	const [content, setContent] = useState('')

	const messages = quote?.messages ?? []
	const openQuestions = quote?.openQuestions ?? []
	const isFrozen = quote?.status === 'frozen'
	const canSend = !isFrozen && !isSending && content.trim().length > 0

	const send = async () => {
		if (!canSend) return
		if (await onSend(content.trim())) setContent('')
	}

	const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		send()
	}

	const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault()
			send()
		}
	}

	const insertQuestion = (question: string) => {
		setContent(current => (current ? `${current}\n${question} ` : `${question} `))
	}

	return (
		<section className={styles.chat}>
			<h2 className={styles.title}>{t('spec.chat.title')}</h2>

			<ol className={styles.messages}>
				{messages.length === 0 && <li className={styles.empty}>{t('spec.chat.empty')}</li>}
				{messages.map((message, index) => (
					<li
						key={`${message.createdAt}-${index}`}
						className={[styles.message, styles[message.role]].join(' ')}
					>
						<span className={styles.role}>{t(`spec.chat.role.${message.role}`)}</span>
						<p className={styles.content}>{message.content}</p>
					</li>
				))}
				{isSending && (
					<li className={[styles.message, styles.assistant].join(' ')}>
						<Spinner />
					</li>
				)}
			</ol>

			{openQuestions.length > 0 && !isFrozen && (
				<div className={styles.questions}>
					<span className={styles.questionsLabel}>{t('spec.chat.openQuestions')}</span>
					{openQuestions.map(question => (
						<button
							key={question}
							type="button"
							className={styles.chip}
							onClick={() => insertQuestion(question)}
						>
							{question}
						</button>
					))}
				</div>
			)}

			<form className={styles.composer} onSubmit={handleSubmit}>
				<textarea
					className={styles.textarea}
					rows={3}
					value={content}
					disabled={isFrozen || isSending}
					placeholder={isFrozen ? t('spec.chat.frozenPlaceholder') : t('spec.chat.placeholder')}
					onChange={event => setContent(event.target.value)}
					onKeyDown={handleKeyDown}
				/>
				<Button type="submit" size="small" disabled={!canSend}>
					{t('spec.chat.action.send')}
				</Button>
			</form>
		</section>
	)
}
