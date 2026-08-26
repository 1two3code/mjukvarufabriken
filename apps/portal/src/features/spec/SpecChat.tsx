import styles from './SpecChat.module.css'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { usePostSpecMessageMutation } from '#/features/spec/specApiSlice.ts'

import { Button } from '#/components/Button.tsx'
import { Spinner } from '#/components/Spinner.tsx'

import type { SpecDraft } from '@mf/models'

type SpecChatProps = {
	draft: SpecDraft
}

export function SpecChat({ draft }: SpecChatProps) {
	const { t } = useTranslation()
	const [postMessage, { isLoading }] = usePostSpecMessageMutation()
	const [content, setContent] = useState('')

	const isFrozen = draft.status === 'frozen'
	const canSend = !isFrozen && !isLoading && content.trim().length > 0

	const send = async () => {
		if (!canSend) return
		const result = await postMessage({ orderId: draft.orderId, content: content.trim() })
		if (!result.error) setContent('')
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
				{draft.messages.length === 0 && <li className={styles.empty}>{t('spec.chat.empty')}</li>}
				{draft.messages.map((message, index) => (
					<li
						key={`${message.createdAt}-${index}`}
						className={[styles.message, styles[message.role]].join(' ')}
					>
						<span className={styles.role}>{t(`spec.chat.role.${message.role}`)}</span>
						<p className={styles.content}>{message.content}</p>
					</li>
				))}
				{isLoading && (
					<li className={[styles.message, styles.assistant].join(' ')}>
						<Spinner />
					</li>
				)}
			</ol>

			{draft.openQuestions.length > 0 && !isFrozen && (
				<div className={styles.questions}>
					<span className={styles.questionsLabel}>{t('spec.chat.openQuestions')}</span>
					{draft.openQuestions.map(question => (
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
					disabled={isFrozen || isLoading}
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
