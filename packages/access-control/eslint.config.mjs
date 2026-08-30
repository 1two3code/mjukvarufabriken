import { defineConfig } from 'eslint/config'

import baseConfig from '../../eslint.config.mjs'

// eslint-disable-next-line no-restricted-syntax
export default defineConfig(...baseConfig, {
	rules: {
		'@typescript-eslint/no-restricted-imports': 'off',
	},
})
