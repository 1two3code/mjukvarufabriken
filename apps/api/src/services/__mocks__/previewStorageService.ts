import fp from 'fastify-plugin'

import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import type { JobStorageResponse } from '@mf/models'

export const createMockJobStorage = (
	overrides?: Partial<JobStorageResponse>
): JobStorageResponse => ({
	bucket: 'mf-preview-test',
	prefix: 'preview/job1/',
	region: 'eu-north-1',
	roleArn: 'arn:aws:iam::123456789012:role/mf-preview/mf-preview-app-job1',
	...overrides,
})

const mockPlugin: FastifyPluginAsync = async app => {
	const mock: FastifyInstance['previewStorageService'] = {
		provision: vi.fn().mockResolvedValue(createMockJobStorage()),
		teardown: vi.fn().mockResolvedValue({ objects: 'deleted', objectCount: 2, role: 'deleted' }),
	}
	app.decorate('previewStorageService', mock)
}

export default fp(mockPlugin, { name: '#internal/previewStorageService' })
