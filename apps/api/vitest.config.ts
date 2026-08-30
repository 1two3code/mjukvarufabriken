import { defineProject } from 'vitest/config'

// eslint-disable-next-line no-restricted-syntax
export default defineProject({
	test: {
		environment: 'node',
		globals: true,
		setupFiles: ['./test/setupTests.ts'],
	},
})
