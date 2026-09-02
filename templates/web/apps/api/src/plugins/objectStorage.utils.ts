/**
 * The two backends of the `objectStorage` plugin: S3 (durable) and in-memory (local dev, tests).
 * The S3 one is written over an injected client so it can be tested without a bucket.
 */
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export type StoredObject = { body: Buffer; contentType: string }

export type ObjectStorage = {
	/** `s3` is durable; `memory` is gone on restart */
	kind: 'memory' | 's3'
	put: (key: string, body: Buffer, contentType: string) => Promise<void>
	get: (key: string) => Promise<StoredObject | undefined>
	/** A URL a browser can fetch the object from for a while (presigned on S3, a data URL in memory) */
	url: (key: string) => Promise<string>
	delete: (key: string) => Promise<boolean>
	close: () => Promise<void>
}

export type S3Like = Pick<S3Client, 'send' | 'destroy'>

/** How long a presigned URL stays valid */
export const urlExpirySeconds = 60 * 60

// MARK: In-memory

export const createMemoryObjectStorage = (): ObjectStorage => {
	const objects = new Map<string, StoredObject>()
	return {
		kind: 'memory',
		put: async (key, body, contentType) => {
			objects.set(key, { body: Buffer.from(body), contentType })
		},
		get: async key => {
			const object = objects.get(key)
			return object && { body: Buffer.from(object.body), contentType: object.contentType }
		},
		url: async key => {
			const object = objects.get(key)
			if (!object) throw new Error(`object not found: ${key}`)
			return `data:${object.contentType};base64,${object.body.toString('base64')}`
		},
		delete: async key => objects.delete(key),
		close: async () => objects.clear(),
	}
}

// MARK: S3

/**
 * Every key lives under `prefix` — the one key space this app's credentials may touch when the
 * bucket is shared (the platform scopes the task role to exactly that prefix). Callers never see
 * the prefix: they put and get by their own keys.
 */
export const createS3ObjectStorage = (
	bucket: string,
	prefix = '',
	client: S3Like = new S3Client({})
): ObjectStorage => {
	const keyOf = (key: string) => `${prefix}${key.replace(/^\/+/, '')}`
	return {
		kind: 's3',
		put: async (key, body, contentType) => {
			await client.send(
				new PutObjectCommand({ Bucket: bucket, Key: keyOf(key), Body: body, ContentType: contentType })
			)
		},
		get: async key => {
			try {
				const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: keyOf(key) }))
				const bytes = await object.Body?.transformToByteArray()
				if (!bytes) return undefined
				return { body: Buffer.from(bytes), contentType: object.ContentType ?? 'application/octet-stream' }
			} catch (error) {
				if ((error as { name?: string }).name === 'NoSuchKey') return undefined
				throw error
			}
		},
		url: async key =>
			getSignedUrl(client as S3Client, new GetObjectCommand({ Bucket: bucket, Key: keyOf(key) }), {
				expiresIn: urlExpirySeconds,
			}),
		delete: async key => {
			await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyOf(key) }))
			return true
		},
		close: async () => client.destroy(),
	}
}
