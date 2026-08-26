import styles from './LegalDocument.module.css'

import { useTranslation } from 'react-i18next'

import {
	legalEnglishSummary,
	legalPartSections,
	legalPreambleSections,
} from '#/features/legal/legalDocument.ts'

import type { LegalPart } from '#/features/legal/legalDocument.ts'

type LegalDocumentProps = {
	part: LegalPart
}

/**
 * One part of the legal draft (`legal/villkor-webb.md`), rendered from HTML produced at build
 * time. The draft notice stays visible until the lawyer review in TODO-EXTERNAL.md is done.
 */
export function LegalDocument({ part }: LegalDocumentProps) {
	const { t } = useTranslation()
	const preamble = legalPreambleSections()
	const sections = legalPartSections(part)
	const summary = legalEnglishSummary()

	return (
		<article className={styles.document}>
			<p className={styles.draft} role="note">
				<strong>{t('legal.draft.label')}</strong> {t('legal.draft.body')}
			</p>
			<p className={styles.language}>{t('legal.language')}</p>
			{[...preamble, ...sections].map((section, index) => (
				<section
					key={`${section.title}-${index}`}
					className={styles.markdown}
					dangerouslySetInnerHTML={{ __html: section.html }}
				/>
			))}
			{summary && (
				<section
					className={[styles.markdown, styles.summary].join(' ')}
					lang="en"
					dangerouslySetInnerHTML={{ __html: summary.html }}
				/>
			)}
		</article>
	)
}
