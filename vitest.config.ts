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
				'packages/resident/src/**/*.ts',
			],
			exclude: ['**/*index.ts', '**/*server.ts', '**/*types.ts', '**/__mocks__/*'],
			// Enforced by `npm run coverage` (CI). Measured 2026-08-27: lines 88 % / functions 81 % /
			// branches 76 % — the bar is deliberately modest so a refactor never fails on coverage alone.
			thresholds: { lines: 60 },
		},
		projects: [
			'apps/api',
			'apps/site',
			'apps/job',
			'packages/utils',
			'packages/harness',
			'packages/db',
			'packages/resident',
		],
	},
})
