import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'

import type { ArtifactStore } from './types.ts'

export const objectUrl = (bucket: string, region: string, key: string) =>
	`https://${bucket}.s3.${region}.amazonaws.com/${key}`

/** The artifacts bucket (`ARTIFACTS_BUCKET`); the job task role may only put, never read or list */
export const createS3ArtifactStore = (bucket: string, region: string): ArtifactStore => {
	const client = new S3Client({ region })
	return {
		bucket,
		urlOf: key => objectUrl(bucket, region, key),
		putObject: async ({ key, body, contentType }) => {
			await client.send(
				new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })
			)
		},
	}
}

// MARK: Fakes

export type FakeArtifactStore = ArtifactStore & {
	objects: Map<string, { body: Uint8Array | string; contentType: string }>
}

export const createFakeArtifactStore = (bucket = 'mf-artifacts-test', fail = false) => {
	const fake: FakeArtifactStore = {
		bucket,
		objects: new Map(),
		urlOf: key => objectUrl(bucket, 'eu-north-1', key),
		putObject: async ({ key, body, contentType }) => {
			if (fail) throw new Error('fake: putObject failed')
			fake.objects.set(key, { body, contentType })
		},
	}
	return fake
}

export const createDryRunArtifactStore = (
	bucket: string,
	log: (line: string) => void
): ArtifactStore => ({
	bucket,
	urlOf: key => objectUrl(bucket, 'eu-north-1', key),
	putObject: async ({ key, body, contentType }) => {
		const size = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength
		log(`[dry-run] s3: put s3://${bucket}/${key} (${contentType}, ${size} bytes)`)
	},
})
