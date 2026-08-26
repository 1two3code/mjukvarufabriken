import fp from 'fastify-plugin'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import type { FastifyPluginAsync } from 'fastify'

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * Presigned downloads from the artifacts bucket (`ARTIFACTS_BUCKET`). `configured` is
		 * false without a bucket — `presignDownload` then throws, and the deliverables route
		 * answers 503 so the portal can say "downloads unavailable" instead of failing silently.
		 */
		s3: {
			configured: boolean
			/** GET URL for `key`, valid for `expiresInSeconds` (default 15 min) */
			presignDownload: (key: string, expiresInSeconds?: number) => Promise<string>
		}
	}
}

/** Deliverable links live 15 minutes — long enough to click, short enough to not be shareable */
export const defaultDownloadExpirySeconds = 15 * 60

const plugin: FastifyPluginAsync = async app => {
	const { artifactsBucket } = app.secrets.infra

	if (!artifactsBucket) {
		app.log.warn('ARTIFACTS_BUCKET not set — deliverable downloads are unavailable')
		app.decorate('s3', {
			configured: false,
			presignDownload: async () => {
				throw new Error('ARTIFACTS_BUCKET is not configured')
			},
		})
		return
	}

	const client = new S3Client({})
	app.addHook('onClose', async () => client.destroy())

	app.decorate('s3', {
		configured: true,
		presignDownload: (key, expiresInSeconds = defaultDownloadExpirySeconds) =>
			getSignedUrl(client, new GetObjectCommand({ Bucket: artifactsBucket, Key: key }), {
				expiresIn: expiresInSeconds,
			}),
	})
}

export default fp(plugin, { name: '#internal/s3', dependencies: ['#internal/secrets'] })
