import fp from 'fastify-plugin'
import {
	CopyObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import type { FastifyPluginAsync } from 'fastify'

/** An object under a listed prefix */
export type ListedObject = { key: string; size: number }

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * The artifacts bucket (`ARTIFACTS_BUCKET`): presigned deliverable downloads, and — for the
		 * final export before a hosting window ends (wave 14) — copies and writes under
		 * `deliverables/<jobId>/export/`. The prefix-scoped reads/deletes on the preview bucket
		 * (`PREVIEW_BUCKET`) that the export and the teardown need live here too, so the api holds
		 * exactly one S3 client. `configured` is false without an artifacts bucket — every artifacts
		 * operation then throws, and the deliverables route answers 503 so the portal can say
		 * "downloads unavailable" instead of failing silently.
		 */
		s3: {
			configured: boolean
			/** GET URL for `key` in the artifacts bucket, valid for `expiresInSeconds` (default 15 min) */
			presignDownload: (key: string, expiresInSeconds?: number) => Promise<string>
			/** Server-side copy into the artifacts bucket; resolves to the copied object's size */
			copyToArtifacts: (
				source: { bucket: string; key: string },
				key: string
			) => Promise<{ size: number }>
			/** Writes a small object (JSON / Markdown) into the artifacts bucket */
			putArtifact: (key: string, body: string, contentType: string) => Promise<{ size: number }>
			/** Every object under `prefix` in `bucket` (paginated to the end) */
			listObjects: (bucket: string, prefix: string) => Promise<ListedObject[]>
			/** Deletes every object under `prefix` in `bucket`; resolves to how many were deleted */
			deletePrefix: (bucket: string, prefix: string) => Promise<number>
		}
	}
}

/** Deliverable links live 15 minutes — long enough to click, short enough to not be shareable */
export const defaultDownloadExpirySeconds = 15 * 60

/** `DeleteObjects` takes at most 1000 keys per call */
const deleteBatchSize = 1000

const unconfigured = () => {
	throw new Error('ARTIFACTS_BUCKET is not configured')
}

const plugin: FastifyPluginAsync = async app => {
	const { artifactsBucket, previewBucket } = app.secrets.infra

	if (!artifactsBucket) {
		app.log.warn('ARTIFACTS_BUCKET not set — deliverable downloads and exports are unavailable')
	}
	if (!artifactsBucket && !previewBucket) {
		app.decorate('s3', {
			configured: false,
			presignDownload: async () => unconfigured(),
			copyToArtifacts: async () => unconfigured(),
			putArtifact: async () => unconfigured(),
			listObjects: async () => [],
			deletePrefix: async () => 0,
		})
		return
	}

	const client = new S3Client({})
	app.addHook('onClose', async () => client.destroy())

	const listObjects = async (bucket: string, prefix: string): Promise<ListedObject[]> => {
		const objects: ListedObject[] = []
		let continuationToken: string | undefined
		do {
			const page = await client.send(
				new ListObjectsV2Command({
					Bucket: bucket,
					Prefix: prefix,
					ContinuationToken: continuationToken,
				})
			)
			for (const object of page.Contents ?? []) {
				if (object.Key) objects.push({ key: object.Key, size: object.Size ?? 0 })
			}
			continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined
		} while (continuationToken)
		return objects
	}

	const requireArtifacts = () => artifactsBucket ?? unconfigured()

	app.decorate('s3', {
		configured: Boolean(artifactsBucket),
		presignDownload: (key, expiresInSeconds = defaultDownloadExpirySeconds) =>
			getSignedUrl(client, new GetObjectCommand({ Bucket: requireArtifacts(), Key: key }), {
				expiresIn: expiresInSeconds,
			}),
		copyToArtifacts: async (source, key) => {
			const bucket = requireArtifacts()
			await client.send(
				new CopyObjectCommand({
					Bucket: bucket,
					Key: key,
					// CopySource is URL-encoded per the S3 API; the bucket name itself needs no encoding
					CopySource: `${source.bucket}/${encodeURIComponent(source.key).replace(/%2F/g, '/')}`,
				})
			)
			const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
			return { size: head.ContentLength ?? 0 }
		},
		putArtifact: async (key, body, contentType) => {
			const bytes = Buffer.from(body, 'utf8')
			await client.send(
				new PutObjectCommand({
					Bucket: requireArtifacts(),
					Key: key,
					Body: bytes,
					ContentType: contentType,
				})
			)
			return { size: bytes.byteLength }
		},
		listObjects,
		deletePrefix: async (bucket, prefix) => {
			const objects = await listObjects(bucket, prefix)
			for (let start = 0; start < objects.length; start += deleteBatchSize) {
				await client.send(
					new DeleteObjectsCommand({
						Bucket: bucket,
						Delete: {
							Objects: objects
								.slice(start, start + deleteBatchSize)
								.map(({ key }) => ({ Key: key })),
							Quiet: true,
						},
					})
				)
			}
			return objects.length
		},
	})
}

export default fp(plugin, { name: '#internal/s3', dependencies: ['#internal/secrets'] })
