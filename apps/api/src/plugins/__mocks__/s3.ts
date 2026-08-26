import fp from 'fastify-plugin'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

export const mockPresignedUrl = (key: string) =>
	`https://mf-artifacts-test.s3.eu-north-1.amazonaws.com/${key}?X-Amz-Signature=test`

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['s3'] = {
		configured: true,
		presignDownload: vi.fn((key: string) => Promise.resolve(mockPresignedUrl(key))),
	}

	app.decorate('s3', mock)
}

export default fp(mockPlugin, { name: '#internal/s3' })
