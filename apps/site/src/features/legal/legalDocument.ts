import villkorWebb from '@legal/villkor-webb.md'

import type { MarkdownSection } from '#/build/markdown.ts'

export type LegalPart = 'terms' | 'privacy'

/** Level 1 headings of `legal/villkor-webb.md` that open each part */
const partHeadings: Record<LegalPart, string> = {
	terms: 'Del A',
	privacy: 'Del B',
}

const englishSummaryHeading = 'English summary'

const isPartHeading = (section: MarkdownSection, part: LegalPart) =>
	section.level === 1 && section.title.startsWith(partHeadings[part])

const isEnglishSummary = (section: MarkdownSection) =>
	section.level === 2 && section.title.startsWith(englishSummaryHeading)

/**
 * The sections of one part of the combined terms + privacy draft: everything from the part's
 * level 1 heading up to the next level 1 heading, without the English summary (which is
 * appended separately on every language).
 */
export const legalPartSections = (part: LegalPart, sections = villkorWebb.sections) => {
	const start = sections.findIndex(section => isPartHeading(section, part))
	if (start === -1) return []
	const rest = sections.slice(start + 1)
	const end = rest.findIndex(section => section.level === 1)
	const body = end === -1 ? rest : rest.slice(0, end)
	return [sections[start]!, ...body.filter(section => !isEnglishSummary(section))]
}

const isAnyPartHeading = (section: MarkdownSection) =>
	(Object.keys(partHeadings) as LegalPart[]).some(part => isPartHeading(section, part))

/** The preamble (draft notice, version, provider) before the first part — the title is dropped */
export const legalPreambleSections = (sections = villkorWebb.sections) => {
	const end = sections.findIndex(isAnyPartHeading)
	return (end === -1 ? sections : sections.slice(0, end))
		.map(section => ({ ...section, html: section.html.replace(/<h1>[^]*?<\/h1>\n?/, '') }))
		.filter(section => section.html.trim())
}

/** The non-binding English summary at the end of the document, if present */
export const legalEnglishSummary = (sections = villkorWebb.sections) =>
	sections.find(isEnglishSummary)
