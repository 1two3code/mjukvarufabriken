import fp from 'fastify-plugin'

import { createMemoryObjectStorage, createS3ObjectStorage } from '#/plugins/objectStorage.utils.ts'

import type { FastifyPluginAsync } from 'fastify'
import type { ObjectStorage } from '#/plugins/objectStorage.utils.ts'

declare module 'fastify' {
	interface FastifyInstance {
		objectStorage: ObjectStorage
	}
}

/**
 * The app's file storage: uploads, images, attachments — anything that is bytes rather than a
 * record (records go in `app.store`).
 *
 * With `ATTACHMENTS_BUCKET` set (every deployed environment — the platform provisions a bucket
 * prefix and credentials for each delivered app and injects both) objects live on S3 under
 * `ATTACHMENTS_PREFIX` and survive restarts. Without it (local development, tests) the same
 * interface runs in memory so the template works with no external services.
 *
 * USE THIS for files — do not create an S3 client of your own or hand-roll a bucket layer; the
 * prefix is the only key space the app's credentials may touch, and this plugin applies it.
 */
const plugin: FastifyPluginAsync = async app => {
	const bucket = process.env.ATTACHMENTS_BUCKET
	const prefix = process.env.ATTACHMENTS_PREFIX ?? ''
	const storage = bucket ? createS3ObjectStorage(bucket, prefix) : createMemoryObjectStorage()

	if (storage.kind === 'memory') {
		app.log.warn(
			'objectStorage: ATTACHMENTS_BUCKET is not set — files are kept in memory and lost on restart'
		)
	} else {
		app.log.info({ bucket, prefix }, 'objectStorage: durable on S3')
	}

	app.decorate('objectStorage', storage)
	app.addHook('onClose', () => storage.close())
}

export default fp(plugin, { name: '#internal/objectStorage' })
