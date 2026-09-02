import fp from 'fastify-plugin'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'

export const mockPresignedUrl = (key: string) =>
	`https://mf-artifacts-test.s3.eu-north-1.amazonaws.com/${key}?X-Amz-Signature=test`

/** What the mocked preview bucket holds under any listed prefix, by default: nothing */
export const createMockListedObjects = (prefix: string, count = 0) =>
	Array.from({ length: count }, (_, index) => ({
		key: `${prefix}photo-${index + 1}.jpg`,
		size: 1000 * (index + 1),
	}))

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['s3'] = {
		configured: true,
		presignDownload: vi.fn((key: string) => Promise.resolve(mockPresignedUrl(key))),
		copyToArtifacts: vi.fn(() => Promise.resolve({ size: 1024 })),
		putArtifact: vi.fn((_key: string, body: string) =>
			Promise.resolve({ size: Buffer.byteLength(body, 'utf8') })
		),
		listObjects: vi.fn(() => Promise.resolve([])),
		deletePrefix: vi.fn(() => Promise.resolve(0)),
	}

	app.decorate('s3', mock)
}

export default fp(mockPlugin, { name: '#internal/s3' })
