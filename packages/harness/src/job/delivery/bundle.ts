import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, relative } from 'node:path'

import { exec, git, tail } from '#job/exec.ts'
import { ensureShared } from '#job/worker.ts'

import type { DeliverableFile, DeliverableFileName } from '@mf/models'
import type { ArtifactStore } from './types.ts'

export const deliverableKeyOf = (jobId: string) => `deliverables/${jobId}/`

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
export const uploadSite = async (
	jobId: string,
	repoDir: string,
	artifacts: ArtifactStore,
	signal?: AbortSignal
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
	for (const file of files) {
		const key = `${prefix}${relative(dist, file).split('\\').join('/')}`
		await artifacts.putObject({
			key,
			body: await readFile(file),
			contentType: contentTypeOf(file),
		})
	}
	return { url: artifacts.urlOf(`${prefix}index.html`), files: files.length }
}
