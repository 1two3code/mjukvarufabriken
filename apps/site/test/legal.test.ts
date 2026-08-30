import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
	legalEnglishSummary,
	legalPartSections,
	legalPreambleSections,
} from '#/features/legal/legalDocument.ts'

import { renderMarkdown, splitMarkdownSections } from '#/build/markdown.ts'

// The real draft, rendered the way the Vite plugin does it at build time
const draft = readFileSync(join(import.meta.dirname, '../../../legal/villkor-webb.md'), 'utf8')
const rendered = renderMarkdown(draft)

describe('Markdown build plugin', () => {
	it('Splits at level 1 and 2 headings and keeps the preamble', () => {
		const sections = splitMarkdownSections(
			'intro\n\n# A\n\ntext\n\n## A.1\n\nmore\n\n# B\n\n### deep'
		)
		expect(sections.map(section => [section.level, section.title])).toEqual([
			[1, ''],
			[1, 'A'],
			[2, 'A.1'],
			[1, 'B'],
		])
		expect(sections[3]!.markdown).toContain('### deep')
	})

	it('Does not split on headings inside fenced code', () => {
		const sections = splitMarkdownSections('# A\n\n```\n# not a heading\n```\n')
		expect(sections).toHaveLength(1)
		expect(sections[0]!.markdown).toContain('# not a heading')
	})

	it('Escapes raw HTML in the source instead of shipping it as markup', () => {
		const { html, sections } = renderMarkdown(
			'# A\n\n<script>alert(1)</script>\n\ntext <img src=x onerror="alert(1)"> end\n'
		)
		for (const output of [html, sections[0]!.html]) {
			expect(output).not.toContain('<script')
			expect(output).not.toContain('<img')
			expect(output).toContain('&lt;script&gt;')
			expect(output).toContain('&lt;img')
		}
	})

	it('Renders GFM tables and blockquotes to HTML', () => {
		const { html } = renderMarkdown('> **DRAFT**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n')
		expect(html).toContain('<blockquote>')
		expect(html).toContain('<table>')
	})
})

describe('Legal document', () => {
	it('Keeps the DRAFT notice in the preamble', () => {
		const preamble = legalPreambleSections(rendered.sections)
		expect(preamble.length).toBeGreaterThan(0)
		expect(preamble.map(section => section.html).join('')).toContain('DRAFT — EJ GRANSKAD')
		expect(preamble.map(section => section.html).join('')).not.toContain('<h1>')
	})

	it('Splits the terms (Del A) from the privacy policy (Del B)', () => {
		const terms = legalPartSections('terms', rendered.sections)
		const privacy = legalPartSections('privacy', rendered.sections)
		expect(terms[0]!.title).toMatch(/^1\. /)
		expect(privacy[0]!.title).toMatch(/^7\. /)
		// The page has its own <h1>; the part's heading is not rendered a second time
		for (const part of [terms, privacy]) {
			expect(part.map(section => section.html).join('')).not.toContain('<h1>')
		}
		expect(terms.some(section => /Cookies/.test(section.title))).toBe(false)
		expect(privacy.some(section => /Cookies/.test(section.title))).toBe(true)
		// Every clause of the draft lands in exactly one part
		const clauses = rendered.sections.filter(section => /^\d+\. /.test(section.title))
		expect(terms.length + privacy.length).toBe(clauses.length)
	})

	it('Exposes the English summary separately from both parts', () => {
		const summary = legalEnglishSummary(rendered.sections)
		expect(summary?.title).toMatch(/^English summary/)
		for (const part of ['terms', 'privacy'] as const) {
			expect(legalPartSections(part, rendered.sections)).not.toContain(summary)
		}
	})
})
