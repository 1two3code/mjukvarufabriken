import { resolve } from 'node:path'
import { defineProject } from 'vitest/config'

import { markdown } from './src/build/markdown.ts'

// eslint-disable-next-line no-restricted-syntax
export default defineProject({
	// Same markdown import + `@legal` alias as vite.config.ts, so feature modules load in tests
	plugins: [markdown()],
	resolve: { alias: { '@legal': resolve(import.meta.dirname, '../../legal') } },
	test: { environment: 'node', globals: true, include: ['test/**/*.test.ts'] },
})
