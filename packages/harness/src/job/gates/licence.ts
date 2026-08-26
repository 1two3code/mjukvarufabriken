import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { exec } from '#job/exec.ts'

import type { LicenceEntry, LicenceGateDetails, LicenceViolation } from '@mf/models'
import type { GateInput, GateOutcome } from '#job/types.ts'

// MARK: Policy

/** File the gate writes into the repo root; committed by delivery with the other docs */
export const licenceFileName = 'THIRD-PARTY-LICENCES.md'

/** Placeholder licence for a package whose `package.json` declares none */
export const unknownLicence = 'UNKNOWN'

/**
 * Strong-copyleft and source-available licences the customer contract (kundavtal §9.2) promises
 * not to introduce unnoticed, plus "no licence at all". Matched per SPDX identifier, so
 * `GPL-2.0-only` is denied while `LGPL-2.1-only` and `GPL-2.0-with-classpath-exception` are not.
 */
const deniedLicence = /^(GPL-2\.0-only|GPL-3\.0-only|AGPL-.*|SSPL-.*|UNLICENSED|UNKNOWN)$/i

/** Waiver id an admin puts in `Job.gateWaivers` to accept one package version */
export const licenceWaiverId = (name: string, version: string) => `licence:${name}@${version}`

/**
 * Evaluates one SPDX expression against the denylist: `A OR B` passes when any alternative
 * passes, `A AND B` passes only when every part passes; a `WITH` exception is kept with its
 * identifier (so a classpath exception is not the bare GPL). Non-SPDX free text is treated as one
 * identifier and passes unless it is on the list — the report shows it as-is for an admin to judge.
 */
export const isDeniedLicence = (expression: string): boolean => {
	const text = expression.trim().replace(/^\(+|\)+$/g, '')
	if (!text) return true
	if (/\sOR\s/.test(text)) return text.split(/\sOR\s/).every(part => isDeniedLicence(part))
	if (/\sAND\s/.test(text)) return text.split(/\sAND\s/).some(part => isDeniedLicence(part))
	return deniedLicence.test(text.replace(/[()]/g, '').trim())
}

// MARK: Collect

/** The subset of `npm ls --all --json --long` the gate reads */
type NpmLsNode = {
	name?: string
	version?: string
	path?: string
	private?: boolean
	missing?: boolean
	dependencies?: Record<string, NpmLsNode>
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

/** Every installed, non-private package once per name@version, via each node's package.json */
export const collectLicences = async (
	tree: NpmLsNode,
	repoDir: string
): Promise<{ entries: LicenceEntry[]; unreadable: string[] }> => {
	const seen = new Map<string, LicenceEntry>()
	const unreadable: string[] = []
	const visit = async (node: NpmLsNode, name: string, isRoot: boolean) => {
		const children = Object.entries(node.dependencies ?? {})
		if (!isRoot && !node.missing && node.version) {
			const key = `${name}@${node.version}`
			if (!seen.has(key)) {
				const path = node.path ?? join(repoDir, 'node_modules', ...name.split('/'))
				let pkg: PackageJson | undefined
				try {
					pkg = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')) as PackageJson
				} catch {
					unreadable.push(key)
				}
				if (!(pkg?.private ?? node.private)) {
					seen.set(key, {
						name,
						version: node.version,
						licence: pkg ? licenceOf(pkg) : unknownLicence,
						repository: pkg ? repositoryUrlOf(pkg) : undefined,
					})
				}
			}
		}
		for (const [childName, child] of children) await visit(child, childName, false)
	}
	await visit(tree, tree.name ?? '', true)
	const entries = [...seen.values()].sort(
		(a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
	)
	return { entries, unreadable }
}

// MARK: Report

const countByLicence = (entries: LicenceEntry[]) => {
	const counts: Record<string, number> = {}
	for (const entry of entries) counts[entry.licence] = (counts[entry.licence] ?? 0) + 1
	return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()

/** Markdown licence list: counts by licence, then one row per package (sorted by name) */
export const renderLicenceFile = (entries: LicenceEntry[], generatedAt: Date) => {
	const counts = Object.entries(countByLicence(entries))
	const countRows = counts.map(([licence, count]) => `| ${cell(licence)} | ${count} |`)
	const rows = entries.map(
		entry =>
			`| ${cell(entry.name)} | ${cell(entry.version)} | ${cell(entry.licence)} | ${entry.repository ? cell(entry.repository) : '-'} |`
	)
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
`
}

// MARK: Gate

export type LicenceGateOptions = {
	npmLs?: NpmLsRunner
	now?: () => Date
}

/**
 * Deterministic licence gate (M4, no model call): lists every installed package, writes
 * `THIRD-PARTY-LICENCES.md` into the repo (delivery commits it with the other docs), and fails
 * on a denylisted or missing licence unless `licence:<pkg>@<version>` is in the job's waivers.
 * The file is written before the verdict so an admin sees the full list even when the gate is red.
 */
export const licenceGate = async (
	{ repoDir, waivers, signal }: GateInput,
	{ npmLs = runNpmLs, now = () => new Date() }: LicenceGateOptions = {}
): Promise<GateOutcome> => {
	const tree = JSON.parse(await npmLs(repoDir, signal)) as NpmLsNode
	const { entries, unreadable } = await collectLicences(tree, repoDir)
	await writeFile(join(repoDir, licenceFileName), renderLicenceFile(entries, now()))

	const violations: LicenceViolation[] = []
	const waived: LicenceViolation[] = []
	for (const entry of entries) {
		if (!isDeniedLicence(entry.licence)) continue
		const waiverId = licenceWaiverId(entry.name, entry.version)
		const violation: LicenceViolation = {
			...entry,
			waiverId,
			reason:
				entry.licence === unknownLicence
					? 'no licence declared in package.json'
					: `licence ${entry.licence} is on the denylist`,
		}
		;(waivers.includes(waiverId) ? waived : violations).push(violation)
	}

	const details: LicenceGateDetails = {
		packages: entries.length,
		byLicence: countByLicence(entries),
		violations,
		waived,
		file: licenceFileName,
	}
	const counts = `${entries.length} package(s), ${Object.keys(details.byLicence).length} licence(s)`
	const notes = [
		waived.length ? `${waived.length} waived` : '',
		unreadable.length
			? `${unreadable.length} package.json unreadable (${unreadable.join(', ')})`
			: '',
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
