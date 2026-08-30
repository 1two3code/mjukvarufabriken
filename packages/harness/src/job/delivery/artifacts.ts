import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { fromTemporaryCredentials } from '@aws-sdk/credential-providers'

import type { ArtifactStore } from './types.ts'

export const objectUrl = (bucket: string, region: string, key: string) =>
	`https://${bucket}.s3.${region}.amazonaws.com/${key}`

/**
 * The two prefixes this job's own uploads ever touch (`bundle.ts`'s `deliverableKeyOf`/
 * `debugKeyOf`/`uploadSite`, all under `deliverables/<jobId>/`, and `uploadSource`'s
 * `delivery-source/<jobId>.zip`) — kept next to the session-policy builder below so the two
 * can't drift apart.
 */
export const artifactResourceArnsOf = (bucket: string, jobId: string) => [
	`arn:aws:s3:::${bucket}/deliverables/${jobId}/*`,
	`arn:aws:s3:::${bucket}/delivery-source/${jobId}.zip`,
]

const artifactActions = [
	's3:PutObject',
	's3:PutObjectLegalHold',
	's3:PutObjectRetention',
	's3:PutObjectTagging',
	's3:PutObjectVersionTagging',
	's3:AbortMultipartUpload',
]

/**
 * Credentials scoped to exactly this job's own S3 prefix/key (M3 hardening #1): the job task
 * role has no S3 permission of its own any more (`infra/lib/resources-stack.ts`) — only
 * `sts:AssumeRole` into `roleArn` (`jobArtifactsRole`, whose OWN ceiling is `deliverables/*` +
 * `delivery-source/*`). The inline session policy here narrows that ceiling to the one job's
 * prefix/key, so a bug or a compromised worker session can at most overwrite (never read/list/
 * delete — the role never had those actions) this job's own deliverable, not another job's.
 * `fromTemporaryCredentials` re-assumes on its own before each ~1h session expires.
 */
const scopedCredentials = (bucket: string, region: string, jobId: string, roleArn: string) =>
	fromTemporaryCredentials({
		params: {
			RoleArn: roleArn,
			RoleSessionName: `job-${jobId}`.slice(0, 64),
			Policy: JSON.stringify({
				Version: '2012-10-17',
				Statement: [
					{ Effect: 'Allow', Action: artifactActions, Resource: artifactResourceArnsOf(bucket, jobId) },
				],
			}),
		},
		clientConfig: { region },
	})

/**
 * The artifacts bucket (`ARTIFACTS_BUCKET`). With `scope` (Fargate: `jobId` + `ARTIFACTS_ROLE_ARN`)
 * every write goes through credentials session-scoped to that job's own prefix/key; without it
 * (local `job:dev`, tests) the ambient credentials are used as-is.
 */
export const createS3ArtifactStore = (
	bucket: string,
	region: string,
	scope?: { jobId: string; roleArn: string }
): ArtifactStore => {
	const client = new S3Client({
		region,
		...(scope ? { credentials: scopedCredentials(bucket, region, scope.jobId, scope.roleArn) } : {}),
	})
	return {
		kind: 's3',
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
		kind: 'fake',
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
	kind: 'dry-run',
	bucket,
	urlOf: key => objectUrl(bucket, 'eu-north-1', key),
	putObject: async ({ key, body, contentType }) => {
		const size = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength
		log(`[dry-run] s3: put s3://${bucket}/${key} (${contentType}, ${size} bytes)`)
	},
})
