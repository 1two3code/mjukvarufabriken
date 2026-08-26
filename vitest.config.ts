import { defineConfig } from 'vitest/config'

// eslint-disable-next-line no-restricted-syntax
export default defineConfig({
	test: {
		coverage: {
			provider: 'v8',
			reporter: ['text', 'lcov'],
			include: [
				'apps/api/src/**/*.ts',
				'packages/utils/src/**/*.ts',
				'packages/harness/src/**/*.ts',
				'packages/db/src/**/*.ts',
				'apps/job/src/**/*.ts',
			],
			exclude: ['**/*index.ts', '**/*server.ts', '**/*types.ts', '**/__mocks__/*'],
		},
		projects: ['apps/api', 'apps/site', 'apps/job', 'packages/utils', 'packages/harness', 'packages/db'],
	},
})
