import { readFile, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { exec } from '#job/exec.ts'

import type { LicenceEntry, LicenceGateDetails, LicenceViolation } from '@mf/models'
import type { GateInput, GateOutcome } from '#job/types.ts'

// MARK: Policy

/** File the gate writes into the repo root; committed by delivery with the other docs */
export const licenceFileName = 'THIRD-PARTY-LICENCES.md'

/** Placeholder licence for a package whose `package.json` declares none */
export const unknownLicence = 'UNKNOWN'

/**
 * Strong-copyleft and source-available licence families the customer contract (kundavtal §9.2)
 * promises not to introduce unnoticed. Matched on the family prefix of one SPDX identifier, so
 * every spelling counts: `GPL-2.0-only`, `GPL-3.0-or-later`, the deprecated `GPL-3.0` / `GPL-2.0+`,
 * free-text `GPLv3` / `GPL`, `AGPL-3.0`, `SSPL-1.0`. `LGPL-*` is another family and passes, and
 * `GPL-2.0-with-classpath-exception` / `GPL-2.0-only WITH Classpath-exception-2.0` pass because
 * the exception lifts the copyleft for linking.
 */
const deniedFamily = /^(GPL|AGPL|SSPL)(?:$|v\d|[-.]\d)(?!.*-with-.*-exception$)/i

/** Identifiers that mean "no usable licence": npm's `UNLICENSED` and the gate's own placeholder */
const noLicence = /^(UNLICENSED|UNKNOWN)$/i

/**
 * Shape of one SPDX licence id (`Apache-2.0`, `BSD-3-Clause`, `GPL-2.0+`, `LicenseRef-x`).
 * Anything else — `SEE LICENSE IN LICENSE.txt`, `Proprietary`, a URL, `Apache License 2.0` — is
 * free text the gate cannot judge, so it needs an admin waiver and shows up as a violation.
 */
const spdxIdentifier = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/

/** Free-text words that name a licence without being an SPDX id; always a waiver decision */
const freeTextLicence = /^(proprietary|commercial|custom|public domain|none|see license.*)$/i

/** Waiver id an admin puts in `Job.gateWaivers` to accept one package version */
export const licenceWaiverId = (name: string, version: string) => `licence:${name}@${version}`

/** Why one licence identifier is denied, or `undefined` when it passes */
const denialOf = (identifier: string): string | undefined => {
	if (noLicence.test(identifier)) return 'no licence declared in package.json'
	if (freeTextLicence.test(identifier) || !spdxIdentifier.test(identifier)) {
		return `"${identifier}" is not an SPDX licence identifier — needs an admin waiver`
	}
	if (deniedFamily.test(identifier)) return `licence ${identifier} is on the denylist`
	return undefined
}

// MARK: SPDX expressions

type SpdxToken = { kind: '(' | ')' | 'OR' | 'AND' | 'WITH' } | { kind: 'id'; id: string }

/**
 * Splits an SPDX expression into parens, operators (any case) and identifiers. Consecutive words
 * that are not operators are kept together as one free-text identifier (`SEE LICENSE IN x`).
 */
const tokenise = (expression: string): SpdxToken[] => {
	const tokens: SpdxToken[] = []
	for (const word of expression.split(/([()])|\s+/).filter(Boolean)) {
		const upper = word.toUpperCase()
		const last = tokens.at(-1)
		if (word === '(' || word === ')') tokens.push({ kind: word })
		else if (upper === 'OR' || upper === 'AND' || upper === 'WITH') tokens.push({ kind: upper })
		else if (last?.kind === 'id') last.id = `${last.id} ${word}`
		else tokens.push({ kind: 'id', id: word })
	}
	return tokens
}

const malformed = 'malformed licence expression'

/**
 * Recursive-descent evaluation against the denylist, returning why the expression is denied or
 * `undefined` when it passes: `A OR B` passes when any alternative passes, `A AND B` passes only
 * when every part passes, parentheses group, `X WITH exception` passes (the exception lifts the
 * copyleft for the customer's use). Anything that does not parse is denied, never silently green.
 */
const evaluate = (tokens: SpdxToken[]): string | undefined => {
	let position = 0
	const peek = (offset = 0) => tokens[position + offset]

	const primary = (): string | undefined => {
		const token = tokens[position++]
		if (token?.kind === '(') {
			const result = alternatives()
			if (peek()?.kind !== ')') return malformed
			position++
			return result
		}
		if (token?.kind !== 'id') return malformed
		if (peek()?.kind !== 'WITH') return denialOf(token.id)
		if (peek(1)?.kind !== 'id') return malformed
		position += 2
		return undefined
	}

	/** `A AND B AND C`: the first denial wins, a malformed part always wins */
	const conjunction = (): string | undefined => {
		const denials: string[] = []
		const first = primary()
		if (first !== undefined) denials.push(first)
		while (peek()?.kind === 'AND') {
			position++
			const part = primary()
			if (part !== undefined) denials.push(part)
		}
		return denials.find(denial => denial === malformed) ?? denials[0]
	}

	/** `A OR B OR C`: passes as soon as one alternative passes, unless a part is malformed */
	const alternatives = (): string | undefined => {
		const results = [conjunction()]
		while (peek()?.kind === 'OR') {
			position++
			results.push(conjunction())
		}
		if (results.includes(malformed)) return malformed
		return results.includes(undefined) ? undefined : results[0]
	}

	const result = alternatives()
	return position < tokens.length ? malformed : result
}

/** Why an SPDX expression (or free-text licence) is denied, or `undefined` when it passes */
export const licenceDenialOf = (expression: string): string | undefined => {
	const text = expression.trim()
	if (!text) return 'no licence declared in package.json'
	return evaluate(tokenise(text))
}

/** `true` when the licence expression is denied (see `licenceDenialOf`) */
export const isDeniedLicence = (expression: string): boolean =>
	licenceDenialOf(expression) !== undefined

// MARK: Collect

/** The subset of `npm ls --all --json --long` the gate reads */
type NpmLsNode = {
	name?: string
	version?: string
	path?: string
	/** Real location after symlink resolution — a workspace member points into the repo, not node_modules */
	realpath?: string
	private?: boolean
	missing?: boolean
	dependencies?: Record<string, NpmLsNode>
	/** npm-level failure (`{ code, summary, detail }`); npm still exits with JSON on stdout */
	error?: { code?: string; summary?: string; detail?: string }
}

type PackageJson = {
	name?: string
	version?: string
	private?: boolean
	license?: string | { type?: string }
	licenses?: Array<string | { type?: string }>
	repository?: string | { url?: string }
}

export type NpmLsRunner = (repoDir: string, signal: AbortSignal) => Promise<string>

/** `npm ls` exits non-zero on extraneous/missing packages but still prints the tree — use stdout */
const runNpmLs: NpmLsRunner = async (repoDir, signal) => {
	const result = await exec('npm', ['ls', '--all', '--json', '--long'], {
		cwd: repoDir,
		signal,
		timeoutMs: 5 * 60_000,
	})
	if (!result.stdout.trim()) {
		throw new Error(`npm ls produced no output (${result.code}): ${result.stderr.trim()}`)
	}
	return result.stdout
}

/** Parses the `npm ls` JSON and refuses an npm-level error payload or a tree without packages */
export const parseNpmLs = (json: string): NpmLsNode => {
	const tree = JSON.parse(json) as NpmLsNode
	if (tree.error) {
		const { code, summary, detail } = tree.error
		throw new Error(`npm ls failed (${code ?? 'unknown'}): ${summary ?? detail ?? ''}`.trim())
	}
	if (!Object.keys(tree.dependencies ?? {}).length) {
		throw new Error('npm ls listed no dependencies — is node_modules installed?')
	}
	return tree
}

const licenceOf = (pkg: PackageJson): string => {
	const single = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type
	if (single?.trim()) return single.trim()
	const many = (pkg.licenses ?? [])
		.map(entry => (typeof entry === 'string' ? entry : entry.type))
		.filter((type): type is string => Boolean(type?.trim()))
	if (many.length === 1) return many[0]!.trim()
	if (many.length > 1) return `(${many.map(type => type.trim()).join(' OR ')})`
	return unknownLicence
}

/** `git+https://github.com/x/y.git` / `github:x/y` / `git@github.com:x/y` → a browsable URL */
export const repositoryUrlOf = (pkg: PackageJson): string | undefined => {
	const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
	if (!raw?.trim()) return undefined
	let url = raw.trim()
	const short = /^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+)$/.exec(url)
	if (short) url = `https://${short[1] ?? 'github'}.com/${short[2]}`
	url = url.replace(/^git\+/, '').replace(/^git@([^:]+):/, 'https://$1/')
	url = url.replace(/^(?:git|ssh):\/\//, 'https://').replace(/^http:\/\//, 'https://')
	url = url.replace(/^https:\/\/git@/, 'https://')
	return url.replace(/\.git$/, '')
}

/**
 * A workspace member of this repo: installed from a path inside the repo that is not under any
 * `node_modules`. Only those are the customer's own code; a `private: true` flag on a package
 * fetched into `node_modules` (git/file dependency) says nothing about its licence.
 */
const isWorkspaceOf = (repoDir: string, ...paths: (string | undefined)[]) =>
	paths.some(path => {
		if (!path) return false
		const inside = relative(repoDir, path)
		if (!inside || inside.startsWith('..')) return false
		return !inside.split(sep).includes('node_modules')
	})

export type CollectedLicences = {
	entries: LicenceEntry[]
	/** `name@version` of nodes whose package.json could not be read (listed as UNKNOWN) */
	unreadable: string[]
	/** `name@version` of nodes npm reports as not installed here (platform-optional or failed) */
	missing: string[]
}

/** Every installed package outside the repo's workspaces, once per name@version */
export const collectLicences = async (
	tree: NpmLsNode,
	repoDir: string
): Promise<CollectedLicences> => {
	const seen = new Map<string, LicenceEntry>()
	const unreadable: string[] = []
	const missing = new Set<string>()
	const readManifest = async (path: string, key: string) => {
		try {
			return JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as PackageJson
		} catch {
			unreadable.push(key)
			return undefined
		}
	}
	const visit = async (node: NpmLsNode, name: string, parentPath: string) => {
		const path = node.path ?? join(parentPath, 'node_modules', ...name.split('/'))
		if (node.missing || !node.version) {
			if (name) missing.add(`${name}@${node.version ?? '?'}`)
		} else if (!isWorkspaceOf(repoDir, path, node.realpath)) {
			const key = `${name}@${node.version}`
			if (!seen.has(key)) {
				const pkg = await readManifest(node.realpath ?? path, key)
				const licence = pkg ? licenceOf(pkg) : unknownLicence
				// A private package with no real licence is the repo's own code (its workspaces are
				// symlinked into node_modules and carry no `license` field) — never published, so its
				// UNKNOWN licence is not a redistribution concern. A private package that DOES declare
				// a licence (a git/file dependency) is still evaluated on that licence.
				const ownPrivateCode = (node.private || pkg?.private) && noLicence.test(licence)
				if (!ownPrivateCode) {
					seen.set(key, {
						name,
						version: node.version,
						licence,
						repository: pkg ? repositoryUrlOf(pkg) : undefined,
					})
				}
			}
		}
		for (const [childName, child] of Object.entries(node.dependencies ?? {})) {
			await visit(child, childName, path)
		}
	}
	for (const [name, child] of Object.entries(tree.dependencies ?? {})) {
		await visit(child, name, tree.path ?? repoDir)
	}
	const entries = [...seen.values()].sort(
		(a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
	)
	return { entries, unreadable, missing: [...missing].sort() }
}

// MARK: Report

const countByLicence = (entries: LicenceEntry[]) => {
	const counts: Record<string, number> = {}
	for (const entry of entries) counts[entry.licence] = (counts[entry.licence] ?? 0) + 1
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

/** Markdown licence list: counts by licence, then one row per package (sorted by name) */
export const renderLicenceFile = (
	entries: LicenceEntry[],
	generatedAt: Date,
	missing: string[] = []
) => {
	const counts = Object.entries(countByLicence(entries))
	const countRows = counts.map(([licence, count]) => `| ${cell(licence)} | ${count} |`)
	const rows = entries.map(
		entry =>
			`| ${cell(entry.name)} | ${cell(entry.version)} | ${cell(entry.licence)} | ${entry.repository ? cell(entry.repository) : '-'} |`
	)
	const missingSection = missing.length
		? `
## Not installed on the build platform

Pinned in \`package-lock.json\` but not installed where this list was generated (typically optional
packages for another OS/CPU), so their licences were not read: ${missing.map(name => `\`${name}\``).join(', ')}.
`
		: ''
	return `# Third-party licences

Generated ${generatedAt.toISOString().slice(0, 10)} from \`npm ls --all\` — every installed package this
repository depends on (production and development), with the licence declared in its
\`package.json\`. Each package is provided under its own licence terms only; \`${unknownLicence}\` means the
package declares none.

## By licence

| Licence | Packages |
|---|---|
${countRows.join('\n') || '| - | 0 |'}

## Packages

| Package | Version | Licence | Repository |
|---|---|---|---|
${rows.join('\n') || '| - | - | - | - |'}
${missingSection}`
}

// MARK: Gate

export type LicenceGateOptions = {
	npmLs?: NpmLsRunner
	now?: () => Date
}

/**
 * Deterministic licence gate (M4, no model call): lists every installed package, writes
 * `THIRD-PARTY-LICENCES.md` into the repo (delivery commits it with the other docs), and fails
 * on a denylisted, missing or unrecognisable licence unless `licence:<pkg>@<version>` is in the
 * job's waivers. An `npm ls` failure throws (the gate is then red as crashed) — a broken
 * enumeration is never a green gate. The file is written before the verdict so an admin sees the
 * full list even when the gate is red.
 */
export const licenceGate = async (
	{ repoDir, waivers, signal }: GateInput,
	{ npmLs = runNpmLs, now = () => new Date() }: LicenceGateOptions = {}
): Promise<GateOutcome> => {
	const tree = parseNpmLs(await npmLs(repoDir, signal))
	const { entries, unreadable, missing } = await collectLicences(tree, repoDir)
	await writeFile(join(repoDir, licenceFileName), renderLicenceFile(entries, now(), missing))

	const violations: LicenceViolation[] = []
	const waived: LicenceViolation[] = []
	for (const entry of entries) {
		const reason = licenceDenialOf(entry.licence)
		if (reason === undefined) continue
		const waiverId = licenceWaiverId(entry.name, entry.version)
		const violation: LicenceViolation = { ...entry, waiverId, reason }
		;(waivers.includes(waiverId) ? waived : violations).push(violation)
	}

	const details: LicenceGateDetails = {
		packages: entries.length,
		byLicence: countByLicence(entries),
		violations,
		waived,
		missing,
		file: licenceFileName,
	}
	const counts = `${entries.length} package(s), ${Object.keys(details.byLicence).length} licence(s)`
	const notes = [
		waived.length ? `${waived.length} waived` : '',
		unreadable.length
			? `${unreadable.length} package.json unreadable (${unreadable.join(', ')})`
			: '',
		missing.length ? `${missing.length} not installed here (${missing.join(', ')})` : '',
	].filter(Boolean)
	if (violations.length) {
		const list = violations.map(v => `${v.name}@${v.version} (${v.licence})`).join(', ')
		return {
			ok: false,
			tokens: 0,
			summary: `${violations.length} package(s) with a denied licence: ${list} — ${counts}${notes.length ? `; ${notes.join('; ')}` : ''}`,
			details,
		}
	}
	return {
		ok: true,
		tokens: 0,
		summary: `${counts}, none denied${notes.length ? `; ${notes.join('; ')}` : ''}; ${licenceFileName} written`,
		details,
	}
}
