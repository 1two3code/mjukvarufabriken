/**
 * Per-delivery object storage (docs/PREVIEW-RESOURCES.md). The database analogue
 * (`previewDbService`) gave a delivered app its own Postgres; this gives it its own S3 prefix and
 * — the part that matters — its own IAM role scoped to exactly that prefix.
 *
 * Why a role per app rather than one shared role: ECS has no session-tag/ABAC passthrough for
 * task roles (containers-roadmap#2426, the same finding that forced the job's own artifact
 * uploads to self-scope via `sts:AssumeRole`), so a single shared task role can only be scoped to
 * `preview/*` — every delivered app would be able to read every other one's objects, with nothing
 * but convention in between. That is precisely the class of weakness Gate B exists to remove, so
 * the role is per job and the prefix is enforced by IAM.
 *
 * Blast radius of giving the api IAM-write: the grant in `resources-stack.ts` is fenced three
 * ways — the role name must match `mf-preview-app-*`, it must sit under the `/mf-preview/` path,
 * and it must carry the `mf-preview-boundary` permissions boundary (which caps anything the role
 * could ever be given at "read/write objects in the preview bucket"). A role created here
 * therefore cannot be made more powerful than the boundary, even by a bug in this file.
 */
import fp from 'fastify-plugin'
import {
	CreateRoleCommand,
	EntityAlreadyExistsException,
	GetRoleCommand,
	IAMClient,
	PutRolePolicyCommand,
} from '@aws-sdk/client-iam'

import type { FastifyPluginAsync } from 'fastify'
import type { JobStorageResponse } from '@mf/models'

declare module 'fastify' {
	interface FastifyInstance {
		previewStorageService: {
			/**
			 * Creates (or reuses, on redelivery) the job's prefix-scoped role and returns the bucket,
			 * prefix, region and role ARN. Throws {@link StorageUnavailable} when no preview bucket
			 * is configured — the job then fails its deploy closed rather than shipping an app whose
			 * every upload 500s.
			 */
			provision: (jobId: string) => Promise<JobStorageResponse>
		}
	}
}

export class StorageUnavailable extends Error {}

// MARK: Pure helpers (exported for tests)

/**
 * The single canonical token derived from a job id. The role name and the prefix are both built
 * from THIS, never from the raw id independently — the policy grants the role its prefix, so two
 * different derivations of "which job" is a way for a role to end up scoped to somebody else's
 * keys. Strictly `[a-z0-9]`, so the name always matches the `mf-preview-app-*` pattern the api's
 * IAM grant is fenced to.
 */
const previewJobToken = (jobId: string): string => {
	const cleaned = jobId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24)
	if (cleaned.length < 4) {
		throw new Error(`preview storage: job id '${jobId}' is too short to derive a name`)
	}
	return cleaned
}

/** Role the delivered task runs as. One per job, scoped to that job's prefix and nothing else. */
export const previewRoleName = (jobId: string): string => `mf-preview-app-${previewJobToken(jobId)}`

/** The one key space this app's role may touch. Trailing slash: `preview/x` must not match `preview/xy` */
export const previewPrefix = (jobId: string): string => `preview/${previewJobToken(jobId)}/`

/** IAM path — part of the fence on the api's own `iam:CreateRole` grant */
export const previewRolePath = '/mf-preview/'

/** Trust policy: only ECS tasks may assume it, and only on behalf of this account */
export const assumeRolePolicy = (account: string) =>
	JSON.stringify({
		Version: '2012-10-17',
		Statement: [
			{
				Effect: 'Allow',
				Principal: { Service: 'ecs-tasks.amazonaws.com' },
				Action: 'sts:AssumeRole',
				Condition: { StringEquals: { 'aws:SourceAccount': account } },
			},
		],
	})

/**
 * The role's only permission: objects under its own prefix, plus the `ListBucket` it needs to
 * enumerate them — itself fenced by `s3:prefix`, or listing would reveal every other app's keys.
 */
export const prefixPolicy = (bucket: string, prefix: string) =>
	JSON.stringify({
		Version: '2012-10-17',
		Statement: [
			{
				Sid: 'ObjectsInOwnPrefixOnly',
				Effect: 'Allow',
				Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
				Resource: `arn:aws:s3:::${bucket}/${prefix}*`,
			},
			{
				Sid: 'ListOwnPrefixOnly',
				Effect: 'Allow',
				Action: 's3:ListBucket',
				Resource: `arn:aws:s3:::${bucket}`,
				Condition: { StringLike: { 's3:prefix': [`${prefix}*`] } },
			},
		],
	})

// MARK: Plugin

const plugin: FastifyPluginAsync = async app => {
	const bucket = process.env.PREVIEW_BUCKET
	const region = process.env.AWS_REGION || 'eu-north-1'
	const boundaryArn = process.env.PREVIEW_ROLE_BOUNDARY_ARN
	const account = process.env.AWS_ACCOUNT_ID

	const iam = new IAMClient({ region })

	app.decorate('previewStorageService', {
		provision: async (jobId: string): Promise<JobStorageResponse> => {
			if (!bucket) {
				throw new StorageUnavailable(
					'no PREVIEW_BUCKET configured — object storage cannot be provisioned for delivered apps'
				)
			}
			if (!account) {
				throw new StorageUnavailable(
					'no AWS_ACCOUNT_ID configured — the delivered app role trust policy cannot be built'
				)
			}
			const roleName = previewRoleName(jobId)
			const prefix = previewPrefix(jobId)

			// Create, or accept an existing role from a redelivery of the same job. Deterministic
			// naming means a rebuild reuses its role instead of leaking one per attempt.
			let roleArn: string
			try {
				const created = await iam.send(
					new CreateRoleCommand({
						RoleName: roleName,
						Path: previewRolePath,
						AssumeRolePolicyDocument: assumeRolePolicy(account),
						// The cap on what this role can EVER hold, independent of the inline policy below
						...(boundaryArn && { PermissionsBoundary: boundaryArn }),
						Description: `Object storage for delivered preview app (job ${jobId})`,
						Tags: [
							{ Key: 'Service', Value: 'mf-delivery' },
							{ Key: 'JobId', Value: jobId },
						],
					})
				)
				roleArn = created.Role?.Arn ?? ''
			} catch (error) {
				if (!(error instanceof EntityAlreadyExistsException)) throw error
				const existing = await iam.send(new GetRoleCommand({ RoleName: roleName }))
				roleArn = existing.Role?.Arn ?? ''
			}
			if (!roleArn) throw new Error(`preview storage: no ARN returned for role ${roleName}`)

			// Always (re)write the inline policy: a redelivery must not inherit a stale prefix, and
			// PutRolePolicy is idempotent.
			await iam.send(
				new PutRolePolicyCommand({
					RoleName: roleName,
					PolicyName: 'own-prefix-only',
					PolicyDocument: prefixPolicy(bucket, prefix),
				})
			)

			app.log.info({ jobId, roleName, prefix }, 'Provisioned preview object storage')
			return { bucket, prefix, region, roleArn }
		},
	})
}

export default fp(plugin, {
	name: '#internal/previewStorageService',
	dependencies: ['#internal/db'],
})
