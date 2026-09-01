import { readFile, realpath, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { exec, execOrThrow, tail } from '#job/exec.ts'

import type { LicenceEntry, LicenceGateDetails, LicenceViolation } from '@mf/models'
import type { GateInput, GateOutcome } from '#job/types.ts'

// MARK: Policy

/** File the gate writes into the repo root and commits itself (see `commitLicenceFile`) */
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

/**
 * Parses the `npm ls` JSON. `npm ls` reports peer/version/extraneous problems as a top-level
 * `error` (ELSPROBLEMS) while still emitting the whole dependency tree — a worker's install can
 * leave such a mismatch (invalid ajv peer, Fargate run 2026-08-27) and it must not crash the gate.
 * We only fail when there is no usable tree at all (e.g. node_modules missing).
 */
export const parseNpmLs = (json: string): NpmLsNode => {
	const tree = JSON.parse(json) as NpmLsNode
	const hasTree = Object.keys(tree.dependencies ?? {}).length > 0
	if (hasTree) {
		if (tree.error) {
			const { code, summary, detail } = tree.error
			console.log(
				JSON.stringify({
					message: 'npm ls reported problems (tree still usable)',
					code: code ?? 'unknown',
					summary: (summary ?? detail ?? '').slice(0, 300),
				})
			)
		}
		return tree
	}
	if (tree.error) {
		const { code, summary, detail } = tree.error
		throw new Error(`npm ls failed (${code ?? 'unknown'}): ${summary ?? detail ?? ''}`.trim())
	}
	throw new Error('npm ls listed no dependencies — is node_modules installed?')
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

/** The subset of `package-lock.json` the gate reads for packages npm did not install here */
type Lockfile = { packages?: Record<string, PackageJson & { link?: boolean }> }

/**
 * `package-lock.json` indexed by package name: `packages` is keyed by install path
 * (`node_modules/a/node_modules/b`), so the name is what follows the last `node_modules/`.
 * Workspace members (`link: true`, or a key that is not under any `node_modules`) are skipped —
 * they are the customer's own code, exactly as in `isWorkspaceOf`.
 */
const indexLockfile = async (repoDir: string) => {
	const index = new Map<string, PackageJson[]>()
	let lock: Lockfile
	try {
		lock = JSON.parse(await readFile(join(repoDir, 'package-lock.json'), 'utf8')) as Lockfile
	} catch {
		return index
	}
	for (const [path, pkg] of Object.entries(lock.packages ?? {})) {
		const at = path.lastIndexOf('node_modules/')
		if (at < 0 || pkg.link) continue
		const name = path.slice(at + 'node_modules/'.length)
		if (!name) continue
		index.set(name, [...(index.get(name) ?? []), pkg])
	}
	return index
}

/**
 * Licence entry for a package `npm ls` reports as not installed here, or `undefined` when the
 * lockfile does not pin it at all.
 *
 * A missing node that IS pinned in `package-lock.json` (an optional binary for another OS/CPU) is
 * part of the delivered dependency set and WILL install in the customer's environment, so it must
 * be evaluated rather than mentioned in prose — that was the whole of audit ORC-06 (57 unchecked
 * packages on the live M4 run, gate green). The lockfile records the licence for registry
 * packages; one it pins without a licence becomes `UNKNOWN`, which the violation loop denies and
 * an admin can waive per `licence:<pkg>@<version>`.
 *
 * A missing node the lockfile does NOT pin is an unmet *optional peer* (`esbuild`, `jsdom`,
 * `sass`, … under vitest/vite): npm installs from the lockfile, so it will not appear in the
 * customer's install either. It stays a note — flagging it would be 28 false violations on the
 * golden template and nothing else.
 */
const entryFromLockfile = (
	name: string,
	version: string | undefined,
	index: Map<string, PackageJson[]>
): LicenceEntry | undefined => {
	const candidates = index.get(name) ?? []
	const pkg =
		(version ? candidates.find(entry => entry.version === version) : undefined) ??
		(candidates.length === 1 ? candidates[0] : undefined)
	if (!pkg) return undefined
	return {
		name,
		version: version ?? pkg.version ?? '?',
		licence: licenceOf(pkg),
		repository: repositoryUrlOf(pkg),
	}
}

/** Every installed package outside the repo's workspaces, once per name@version */
export const collectLicences = async (
	tree: NpmLsNode,
	repoDir: string
): Promise<CollectedLicences> => {
	const seen = new Map<string, LicenceEntry>()
	const unreadable: string[] = []
	const missing = new Set<string>()
	// `name@version` → what npm reported (version undefined when npm knows none); resolved from
	// the lockfile once the whole tree is walked, so an installed copy elsewhere always wins
	const notInstalled = new Map<string, { name: string; version?: string }>()
	// The on-disk real path (follows a workspace symlink); undefined when the path is gone/unresolvable
	const realpathOf = (path: string) => realpath(path).then(resolved => resolved, () => undefined)
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
			if (name) {
				const key = `${name}@${node.version ?? '?'}`
				missing.add(key)
				notInstalled.set(key, { name, version: node.version })
			}
			for (const [childName, child] of Object.entries(node.dependencies ?? {})) {
				await visit(child, childName, path)
			}
			return
		}
		// `npm ls --long` omits `realpath` for symlinked workspaces (it reports `path` under
		// node_modules and a `file:` `resolved`), so resolve the real location from disk. A node whose
		// real path is inside the repo but outside node_modules is the customer's own workspace (their
		// symlinked code, private and licence-less by design) and is skipped. Everything else — a real
		// dir in node_modules, or a link pointing outside the repo — is a third-party dependency and is
		// evaluated even when `private: true` (a private git/file dep still needs listing), so an
		// unlicensed one never escapes both THIRD-PARTY-LICENCES.md and the violation check.
		const real = node.realpath ?? (await realpathOf(path))
		if (!isWorkspaceOf(repoDir, path, real)) {
			const key = `${name}@${node.version}`
			if (!seen.has(key)) {
				const pkg = await readManifest(real ?? path, key)
				seen.set(key, {
					name,
					version: node.version,
					licence: pkg ? licenceOf(pkg) : unknownLicence,
					repository: pkg ? repositoryUrlOf(pkg) : undefined,
				})
			}
		}
		for (const [childName, child] of Object.entries(node.dependencies ?? {})) {
			await visit(child, childName, path)
		}
	}
	for (const [name, child] of Object.entries(tree.dependencies ?? {})) {
		await visit(child, name, tree.path ?? repoDir)
	}
	if (notInstalled.size) {
		const lockfile = await indexLockfile(repoDir)
		for (const { name, version } of notInstalled.values()) {
			const entry = entryFromLockfile(name, version, lockfile)
			if (!entry) continue
			const key = `${entry.name}@${entry.version}`
			if (!seen.has(key)) seen.set(key, entry)
		}
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

Declared but not installed where this list was generated: optional packages for another OS/CPU,
and optional peer dependencies nothing asked for. The ones \`package-lock.json\` pins are listed
above with the licence it records for them; the rest install nowhere, here or at your site:
${missing.map(name => `\`${name}\``).join(', ')}.
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
 * Commits the manifest in the gate that produced it. It used to be left untracked for delivery's
 * `commitDocs` to pick up, but the very next gate (`acceptance-check`) ends in a mandatory
 * `git clean -qfd` that deleted exactly this file, so every delivered repo, `repo.zip` and bundle
 * shipped without the file HANDOVER.md points at, with a green `licence` gate over the top
 * (audit ORC-01, 2026-08-31). The `git add` is scoped to the one path so the gate never sweeps in
 * whatever a preceding session left in the working tree; an unchanged file (a re-run) commits
 * nothing and is not an error, as long as the file is in HEAD afterwards.
 */
const commitLicenceFile = async (repoDir: string, signal: AbortSignal) => {
	const options = { cwd: repoDir, signal }
	await execOrThrow('git', ['add', '--', licenceFileName], options)
	const commit = await exec(
		'git',
		['commit', '-q', '-m', `docs(licence): ${licenceFileName} (auto-commit)`, '--', licenceFileName],
		options
	)
	if (commit.code === 0) return
	const inHead = await exec('git', ['cat-file', '-e', `HEAD:${licenceFileName}`], options)
	if (inHead.code !== 0) {
		throw new Error(
			`could not commit ${licenceFileName} (${commit.code}): ${tail(commit.stderr || commit.stdout, 5)}`
		)
	}
}

/**
 * Deterministic licence gate (M4, no model call): lists every installed package, writes
 * `THIRD-PARTY-LICENCES.md` into the repo and commits it, and fails on a denylisted, missing or
 * unrecognisable licence unless `licence:<pkg>@<version>` is in the job's waivers. An `npm ls`
 * failure throws (the gate is then red as crashed) — a broken enumeration is never a green gate.
 * The file is written and committed before the verdict so an admin sees the full list even when
 * the gate is red.
 */
export const licenceGate = async (
	{ repoDir, waivers, signal }: GateInput,
	{ npmLs = runNpmLs, now = () => new Date() }: LicenceGateOptions = {}
): Promise<GateOutcome> => {
	const tree = parseNpmLs(await npmLs(repoDir, signal))
	const { entries, unreadable, missing } = await collectLicences(tree, repoDir)
	await writeFile(join(repoDir, licenceFileName), renderLicenceFile(entries, now(), missing))
	await commitLicenceFile(repoDir, signal)

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
		summary: `${counts}, none denied${notes.length ? `; ${notes.join('; ')}` : ''}; ${licenceFileName} written and committed`,
		details,
	}
}
