import {
	GetObjectCommand,
	ListObjectsV2Command,
	NoSuchKey,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3'

/**
 * The resident's only persistent state: one S3 bucket in the customer's account holding the
 * audit log (`audit/<day>.jsonl`), the usage records (`usage/<day>.json`), the month counters
 * (`months/<month>.json`) and the pause flag (`state/paused.json`). Everything is a whole-object
 * read/write, so an in-memory map is a faithful fake.
 */
export type ObjectStore = {
	/** Object body as text, or undefined when the key does not exist */
	get: (key: string) => Promise<string | undefined>
	put: (key: string, body: string, contentType?: string) => Promise<void>
	/** Keys under `prefix`, sorted */
	list: (prefix: string) => Promise<string[]>
}

export const createS3ObjectStore = (bucket: string, region?: string): ObjectStore => {
	const client = new S3Client(region ? { region } : {})
	return {
		get: async key => {
			try {
				const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
				return await result.Body?.transformToString()
			} catch (error) {
				if (error instanceof NoSuchKey || (error as { name?: string }).name === 'NoSuchKey') {
					return undefined
				}
				throw error
			}
		},
		put: async (key, body, contentType = 'application/json') => {
			await client.send(
				new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })
			)
		},
		list: async prefix => {
			const keys: string[] = []
			let token: string | undefined
			do {
				const page = await client.send(
					new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
				)
				keys.push(...(page.Contents ?? []).flatMap(entry => (entry.Key ? [entry.Key] : [])))
				token = page.IsTruncated ? page.NextContinuationToken : undefined
			} while (token)
			return keys.sort()
		},
	}
}

export type MemoryObjectStore = ObjectStore & { objects: Map<string, string> }

/** In-memory store for tests and `RESIDENT_DRY_RUN` (nothing survives a restart) */
export const createMemoryObjectStore = (): MemoryObjectStore => {
	const objects = new Map<string, string>()
	return {
		objects,
		get: async key => objects.get(key),
		put: async (key, body) => {
			objects.set(key, body)
		},
		list: async prefix => [...objects.keys()].filter(key => key.startsWith(prefix)).sort(),
	}
}
