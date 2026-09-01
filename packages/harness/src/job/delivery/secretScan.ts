/**
 * Deterministic secret scan of the delivery tree (hardening audit 2026-08-30, Gate B finding
 * A2). Runs after the docs commit and BEFORE the repo push / bundle upload: even with egress
 * locked and the raw key out of the worker env, a prompt-injected worker can still write a
 * credential it obtained some other way into a source file, README or `.env.example` — which
 * would then be pushed to a repo the CUSTOMER is a collaborator on and land in `repo.zip`.
 *
 * This is the one delivery control that is prompt-injection-proof by construction: no model in
 * the loop, only regexes over the committed tree and the git history of the delivery branch, so
 * no spec text can argue it away (unlike the review gate, see finding B1). It fails closed —
 * any hit aborts the delivery with a redacted report (`file:line` + pattern name, NEVER the
 * matched text, which would copy the credential into job events/logs).
 *
 * Scope: every tracked file (exactly what `git push` and the `repo.zip` archive carry —
 * `node_modules` and other untracked files are not pushed/archived) plus every blob reachable
 * from any ref (a secret committed and then removed still leaves with the repo). Tracked
 * BINARY and oversize files are scanned too — as raw bytes, since all patterns and known-secret
 * needles are ASCII: `printf '\0\n%s' "$SECRET" > x.bin` must not slip past the gate. History
 * is enumerated as blobs (`rev-list --objects`), not as `git log -p` patches, so merge commits
 * (an "evil merge" that introduces a file no parent had) and binary blobs are covered as well.
 * Encoding games (base64, UTF-16) remain out of reach for any byte-pattern scanner — the
 * known-secret needle match is byte-literal.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { git } from '#job/exec.ts'

export type SecretScanHit = {
	/** `<file>:<line>` for a tree hit, `history:<blob12>[:<path>]` for one only in a past commit */
	location: string
	/** Which pattern matched (never the matched text itself) */
	pattern: string
}

export type SecretScanReport = {
	ok: boolean
	filesScanned: number
	hits: SecretScanHit[]
}

/**
 * Credential-shaped token patterns: every provider this platform itself holds a credential for
 * (the realistic leak set), plus generic private-key blocks. Deliberately narrow and literal —
 * a false positive here blocks a delivery, so no entropy heuristics. All ASCII, so they work on
 * a latin1 view of raw bytes (binary files included) without any text decoding.
 */
const tokenPatterns: { name: string; pattern: RegExp }[] = [
	{ name: 'anthropic-api-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/ },
	{
		name: 'github-token',
		pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
	},
	{ name: 'aws-access-key-id', pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{
		name: 'aws-secret-access-key',
		pattern: /\baws_secret_access_key\b["'\s:=]{1,10}[A-Za-z0-9/+]{40}\b/i,
	},
	{ name: 'stripe-secret-key', pattern: /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}\b/ },
	{ name: 'stripe-webhook-secret', pattern: /\bwhsec_[A-Za-z0-9]{16,}\b/ },
	{ name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

/**
 * Nothing this large belongs in a delivery (GitHub refuses >100 MB files outright). Fail
 * CLOSED on it — an unscanned delivered file must block, never skip: a skip here would be the
 * exfil channel (hide the secret past the cap).
 */
const maxScannedBytes = 100 * 1024 * 1024
const oversizePattern = 'unscannable-oversize'

/**
 * Literal matchers for the job's OWN live secret values (Anthropic key, GitHub App private key,
 * report token, database URL — whatever the caller knows). Values shorter than 8 chars are
 * ignored (too noisy to mean anything); multi-line values (PEM keys) also match per line, so a
 * re-wrapped key still hits.
 */
const knownSecretNeedles = (knownSecrets: string[]): string[] => {
	const needles = new Set<string>()
	for (const secret of knownSecrets) {
		const value = secret.trim()
		if (value.length < 8) continue
		needles.add(value)
		for (const line of value.split(/\r?\n/)) {
			const trimmed = line.trim()
			// PEM armor lines are generic (they are their own pattern above); body lines are unique
			if (trimmed.length >= 24 && !trimmed.startsWith('-----')) needles.add(trimmed)
		}
	}
	return [...needles]
}

const scanLine = (line: string, needles: string[]): string | undefined => {
	for (const { name, pattern } of tokenPatterns) if (pattern.test(line)) return name
	for (const needle of needles) if (line.includes(needle)) return 'known-secret-value'
	return undefined
}

const scanText = (
	text: string,
	needles: string[],
	locationOf: (lineNumber: number) => string
): SecretScanHit[] => {
	const hits: SecretScanHit[] = []
	const lines = text.split('\n')
	for (let index = 0; index < lines.length; index++) {
		const pattern = scanLine(lines[index]!, needles)
		if (pattern) hits.push({ location: locationOf(index + 1), pattern })
	}
	return hits
}

/**
 * Byte-safe view of possibly-binary content: latin1 maps every byte to one char, so the ASCII
 * token patterns and needle strings match raw bytes exactly — no utf8 decoding to mangle them.
 */
const scanBytes = (
	content: Buffer,
	needles: string[],
	locationOf: (lineNumber: number) => string
): SecretScanHit[] =>
	content.length > maxScannedBytes
		? [{ location: locationOf(1), pattern: oversizePattern }]
		: scanText(content.toString('latin1'), needles, locationOf)

export type SecretScanOptions = {
	/** The job's own live secret values — matched literally (and per line, for PEM keys) */
	knownSecrets?: string[]
	signal?: AbortSignal
}

/**
 * Scans a set of delivered files that git does NOT cover — the SPA site upload
 * (`uploadSite`), whose `dist/` output is untracked but ships to a served URL all the same.
 * Same patterns, same fail-closed contract as `scanRepoForSecrets`.
 */
export const scanDeliveredFiles = (
	files: { name: string; content: Buffer }[],
	knownSecrets: string[] = []
): SecretScanReport => {
	const needles = knownSecretNeedles(knownSecrets)
	const hits: SecretScanHit[] = []
	for (const { name, content } of files) {
		hits.push(...scanBytes(content, needles, lineNumber => `${name}:${lineNumber}`))
	}
	return { ok: hits.length === 0, filesScanned: files.length, hits }
}

/**
 * Scans the committed tree and the full git history of `repoDir` for credential-shaped strings.
 * `ok: false` means the delivery must not leave the building; the report is redacted (locations
 * and pattern names only).
 */
export const scanRepoForSecrets = async (
	repoDir: string,
	{ knownSecrets = [], signal }: SecretScanOptions = {}
): Promise<SecretScanReport> => {
	const needles = knownSecretNeedles(knownSecrets)
	const hits: SecretScanHit[] = []

	// MARK: Committed tree — exactly the file set `git push` and `git archive` deliver.
	// `-s` also yields each file's blob id, so the history pass below can skip blobs this pass
	// already covered (identical content ⇒ identical id).
	const listed = await git(['ls-files', '-z', '-s'], { cwd: repoDir, signal })
	const treeBlobIds = new Set<string>()
	let filesScanned = 0
	for (const entry of listed.stdout.split('\0')) {
		// "<mode> <blobid> <stage>\t<path>"
		const match = /^\S+ ([0-9a-f]{40,64}) \S+\t(.+)$/s.exec(entry)
		if (!match) continue
		const [, blobId, file] = match as unknown as [string, string, string]
		treeBlobIds.add(blobId)
		let content: Buffer
		try {
			content = await readFile(join(repoDir, file))
		} catch {
			continue // listed but unreadable (e.g. a broken symlink) — nothing to leak from here
		}
		filesScanned += 1
		hits.push(...scanBytes(content, needles, lineNumber => `${file}:${lineNumber}`))
	}

	// MARK: History — a secret committed then removed still leaves in the pushed history. Every
	// blob reachable from any ref is scanned, not `git log -p` output: patches print nothing for
	// binary blobs and skip merge-commit diffs entirely, which would leave delivered bytes
	// unscanned. Blobs also present in the current tree were already scanned above (with a
	// better location), so only historical ones remain — typically few.
	const reachable = await git(['rev-list', '--objects', '--all'], { cwd: repoDir, signal })
	const pathOf = new Map<string, string>()
	for (const line of reachable.stdout.split('\n')) {
		const match = /^([0-9a-f]{40,64})(?: (.*))?$/.exec(line)
		if (match) pathOf.set(match[1]!, match[2] ?? '')
	}
	const typed = await git(
		['cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectname) %(objectsize)'],
		{ cwd: repoDir, signal }
	)
	for (const line of typed.stdout.split('\n')) {
		const match = /^blob ([0-9a-f]{40,64}) (\d+)$/.exec(line)
		if (!match) continue
		const [, blobId, size] = match as unknown as [string, string, string]
		if (treeBlobIds.has(blobId) || !pathOf.has(blobId)) continue // in the tree / not reachable
		const path = pathOf.get(blobId)
		const locationOf = () => `history:${blobId.slice(0, 12)}${path ? `:${path}` : ''}`
		if (Number(size) > maxScannedBytes) {
			hits.push({ location: locationOf(), pattern: oversizePattern })
			continue
		}
		const blob = await git(['cat-file', 'blob', blobId], { cwd: repoDir, signal })
		// One hit per pattern per blob — line numbers in a deleted blob are not actionable
		const patterns = new Set(
			scanText(blob.stdout, needles, () => '').map(hit => hit.pattern)
		)
		for (const pattern of patterns) hits.push({ location: locationOf(), pattern })
	}

	return { ok: hits.length === 0, filesScanned, hits }
}

/** One-line, redacted failure reason for the gate report / job events */
export const secretScanReason = (report: SecretScanReport): string =>
	`secret scan: ${report.hits.length} credential-shaped string(s) in the delivery — ` +
	report.hits
		.slice(0, 10)
		.map(hit => `${hit.location} (${hit.pattern})`)
		.join(', ') +
	(report.hits.length > 10 ? `, +${report.hits.length - 10} more` : '')
