import { marked } from 'marked'

import type { PluginOption } from 'vite'

export type MarkdownSection = {
	/** Heading level of the section (1 or 2); the preamble before the first heading is level 1 */
	level: 1 | 2
	/** Heading text without the `#` marks (empty for the preamble) */
	title: string
	/** The section rendered to HTML, heading included */
	html: string
}

export type MarkdownModule = {
	html: string
	sections: MarkdownSection[]
}

const headingPattern = /^(#{1,2}) (.+)$/

const isFence = (line: string) => line.startsWith('```')

const escapeHtml = (text: string) =>
	text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/**
 * Raw HTML in the Markdown source is shown as text, never shipped as markup: the legal drafts
 * are pasted in from outside the repo and end up in every visitor's browser via innerHTML.
 */
const renderer = new marked.Renderer()
renderer.html = ({ text }) => escapeHtml(text)

const render = (markdown: string) => marked.parse(markdown, { async: false, gfm: true, renderer })

/**
 * Splits a Markdown document at its level 1 and 2 headings. Text before the first heading
 * becomes a level 1 section without a title (the preamble); fenced code is never split.
 */
export const splitMarkdownSections = (markdown: string) => {
	const sections: { level: 1 | 2; title: string; lines: string[] }[] = [
		{ level: 1, title: '', lines: [] },
	]
	let inFence = false
	for (const line of markdown.split('\n')) {
		if (isFence(line)) inFence = !inFence
		const heading = inFence ? null : headingPattern.exec(line)
		if (heading) {
			sections.push({ level: heading[1]!.length as 1 | 2, title: heading[2]!.trim(), lines: [] })
		}
		sections.at(-1)!.lines.push(line)
	}
	return sections
		.filter(section => section.lines.some(line => line.trim()))
		.map(({ level, title, lines }) => ({ level, title, markdown: lines.join('\n') }))
}

export const renderMarkdown = (markdown: string): MarkdownModule => ({
	html: render(markdown),
	sections: splitMarkdownSections(markdown).map(section => ({
		level: section.level,
		title: section.title,
		html: render(section.markdown),
	})),
})

/**
 * Vite plugin: `import doc from 'x.md'` gives `{ html, sections }` rendered at build time, so
 * the site ships plain HTML strings and no Markdown parser or runtime fetch.
 */
export function markdown(): PluginOption {
	return {
		name: 'markdown',
		transform(code, id) {
			if (!id.endsWith('.md')) return null
			return { code: `export default ${JSON.stringify(renderMarkdown(code))}`, map: null }
		},
	}
}
