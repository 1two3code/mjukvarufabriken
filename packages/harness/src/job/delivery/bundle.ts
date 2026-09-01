import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, relative } from 'node:path'

import { exec, git, tail } from '#job/exec.ts'
import { ensureShared } from '#job/worker.ts'
import { transcriptsDir } from '#job/transcript.ts'

import { scanDeliveredFiles, secretScanReason } from './secretScan.ts'
import { acceptanceReportOf } from './types.ts'

import type { DeliverableFile, DeliverableFileName, GateReport } from '@mf/models'
import type { ArtifactStore } from './types.ts'

export const deliverableKeyOf = (jobId: string) => `deliverables/${jobId}/`

/** Where a failed build's debug archive goes, so its gates can be re-run locally without a rebuild */
export const debugKeyOf = (jobId: string) => `${deliverableKeyOf(jobId)}debug/`

/** `git archive` of `main` as a zip in a temp dir; returns the bytes */
export const archiveMain = async (repoDir: string, signal?: AbortSignal) => {
	const dir = await mkdtemp(join(tmpdir(), 'mf-bundle-'))
	const zipPath = join(dir, 'repo.zip')
	try {
		await git(['archive', '--format=zip', '-o', zipPath, 'main'], { cwd: repoDir, signal })
		return await readFile(zipPath)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

const contentTypes: Record<string, string> = {
	'.zip': 'application/zip',
	'.md': 'text/markdown; charset=utf-8',
	'.json': 'application/json',
	'.jsonl': 'application/x-ndjson',
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.txt': 'text/plain; charset=utf-8',
	'.webmanifest': 'application/manifest+json',
}
export const contentTypeOf = (name: string) =>
	contentTypes[extname(name).toLowerCase()] ?? 'application/octet-stream'

export type BundleInput = {
	jobId: string
	repoDir: string
	artifacts: ArtifactStore
	docs: { 'HANDOVER.md': string; 'TEST-REPORT.md': string }
	gatesJson: string
	acceptanceJson: string
	signal?: AbortSignal
}

/** Uploads repo.zip + docs + reports under `deliverables/<jobId>/`; returns the file list */
export const uploadBundle = async ({
	jobId,
	repoDir,
	artifacts,
	docs,
	gatesJson,
	acceptanceJson,
	signal,
}: BundleInput): Promise<DeliverableFile[]> => {
	const prefix = deliverableKeyOf(jobId)
	const entries: [DeliverableFileName, Uint8Array | string][] = [
		['repo.zip', await archiveMain(repoDir, signal)],
		['HANDOVER.md', docs['HANDOVER.md']],
		['TEST-REPORT.md', docs['TEST-REPORT.md']],
		['gates.json', gatesJson],
		['acceptance.json', acceptanceJson],
	]
	const files: DeliverableFile[] = []
	for (const [name, body] of entries) {
		const key = `${prefix}${name}`
		await artifacts.putObject({ key, body, contentType: contentTypeOf(name) })
		const size = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength
		files.push({ name, key, size })
	}
	return files
}

export type DebugBundleInput = {
	jobId: string
	repoDir: string
	artifacts: ArtifactStore
	/** Gate reports gathered so far (may be empty when the build failed before the gates) */
	gates: GateReport[]
	signal?: AbortSignal
}

/**
 * Uploads the built repository (`git archive` of `main`) and the gate/acceptance reports of a
 * FAILED job under `deliverables/<jobId>/debug/`, so a real build can be pulled once and its gates
 * re-run locally forever (`gates-demo --repo <dir>`) instead of paying for another live rebuild.
 * Best-effort: the caller swallows its errors and only invokes it when the artifact store is real
 * (a bucket is configured) — the same real-S3-in-dry-run rule as the delivery bundle.
 */
export const uploadDebugBundle = async ({
	jobId,
	repoDir,
	artifacts,
	gates,
	signal,
}: DebugBundleInput): Promise<DeliverableFile[]> => {
	const prefix = debugKeyOf(jobId)
	// Worker session transcripts (best-effort; present only when sessions ran) — the 'why' behind
	// a failure, which repo.zip (main, so without a failed task's uncommitted work) can't show.
	const tdir = transcriptsDir(repoDir)
	const transcriptNames = (await readdir(tdir).catch(() => [] as string[])).filter(name =>
		name.endsWith('.jsonl')
	)
	const transcriptEntries = await Promise.all(
		transcriptNames.map(
			async name =>
				[`transcripts/${name}`, await readFile(join(tdir, name))] as unknown as [
					DeliverableFileName,
					Uint8Array,
				]
		)
	)
	const entries: [DeliverableFileName, Uint8Array | string][] = [
		['repo.zip', await archiveMain(repoDir, signal)],
		['gates.json', JSON.stringify(gates, null, 2)],
		['acceptance.json', JSON.stringify(acceptanceReportOf(gates) ?? {}, null, 2)],
		...transcriptEntries,
	]
	const files: DeliverableFile[] = []
	for (const [name, body] of entries) {
		const key = `${prefix}${name}`
		await artifacts.putObject({ key, body, contentType: contentTypeOf(name) })
		const size = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength
		files.push({ name, key, size })
	}
	return files
}

// MARK: Static site

/** Vite output dirs the template produces (`dist/<mode>`), first match wins */
const siteDistCandidates = ['apps/app/dist/live', 'apps/app/dist/dev', 'apps/app/dist']

const listFiles = async (dir: string): Promise<string[]> => {
	const found: string[] = []
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name)
		if (entry.isDirectory()) found.push(...(await listFiles(full)))
		else found.push(full)
	}
	return found
}

const findSiteDist = async (repoDir: string) => {
	for (const candidate of siteDistCandidates) {
		const dir = join(repoDir, candidate)
		const isDir = await stat(dir).then(
			info => info.isDirectory(),
			() => false
		)
		if (isDir && (await stat(join(dir, 'index.html')).catch(() => undefined))) return dir
	}
	return undefined
}

export type SiteUploadOutcome = { url: string | null; files: number; reason?: string }

/**
 * `npm run build` in the repo — the repo's build scripts, vite config and plugins are customer
 * (model-written) code, so it runs as the worker uid like every other repo script — and upload
 * the SPA bundle to `deliverables/<jobId>/site/`.
 * v1 limitation: the artifacts bucket is private and not a website endpoint, so the returned
 * URL only works through a presigned link / the console — a CloudFront preview is M6+.
 */
/**
 * Uploads this job's built repo (`git archive` of `main`) as the per-job CodeBuild source zip,
 * so the image build reads THIS repo, not the project's fixed source. Returns its S3 location.
 */
export const uploadSource = async (
	jobId: string,
	repoDir: string,
	artifacts: ArtifactStore,
	signal?: AbortSignal
): Promise<{ bucket: string; key: string }> => {
	// Under `delivery-source/` (an internal build input, not a customer deliverable) so the
	// CodeBuild role's prefix grant covers it; per job so concurrent deliveries never collide.
	const key = `delivery-source/${jobId}.zip`
	await artifacts.putObject({
		key,
		body: await archiveMain(repoDir, signal),
		contentType: 'application/zip',
	})
	return { bucket: artifacts.bucket, key }
}

export const uploadSite = async (
	jobId: string,
	repoDir: string,
	artifacts: ArtifactStore,
	signal?: AbortSignal,
	knownSecrets: string[] = []
): Promise<SiteUploadOutcome> => {
	await ensureShared(repoDir)
	const build = await exec('npm', ['run', 'build', '--silent'], {
		cwd: repoDir,
		signal,
		asWorker: true,
	})
	if (build.code !== 0) {
		return {
			url: null,
			files: 0,
			reason: `npm run build failed (${build.code}):\n${tail(`${build.stdout}\n${build.stderr}`, 40)}`,
		}
	}
	const dist = await findSiteDist(repoDir)
	if (!dist) return { url: null, files: 0, reason: 'no SPA build output (apps/app/dist) found' }
	const prefix = `${deliverableKeyOf(jobId)}site/`
	const files = await listFiles(dist)
	// Secret scan (hardening A2): dist/ is UNTRACKED build output — the repo-tree scan never sees
	// it, yet every byte here ships to a served URL. `npm run build` is model-written code running
	// as the worker, and pre-planted files in an unused dist/<mode> dir survive the rebuild, so
	// scan exactly the bytes about to be uploaded and fail closed BEFORE uploading any of them.
	const entries = await Promise.all(
		files.map(async file => ({
			name: relative(dist, file).split('\\').join('/'),
			content: await readFile(file),
		}))
	)
	const scan = scanDeliveredFiles(entries, knownSecrets)
	if (!scan.ok) return { url: null, files: 0, reason: `site upload blocked — ${secretScanReason(scan)}` }
	for (const { name, content } of entries) {
		await artifacts.putObject({
			key: `${prefix}${name}`,
			body: content,
			contentType: contentTypeOf(name),
		})
	}
	return { url: artifacts.urlOf(`${prefix}index.html`), files: files.length }
}
