import importPlugin from 'eslint-plugin-import'
import { defineConfig } from 'eslint/config'

// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import baseConfig from '../../eslint.config.mjs'

// eslint-disable-next-line no-restricted-syntax
export default defineConfig(...baseConfig, [
	{
		rules: {
			'@typescript-eslint/naming-convention': [
				'warn',
				{
					selector: 'variableLike',
					format: ['strictCamelCase', 'UPPER_CASE'],
					leadingUnderscore: 'allow',
				},
			],
		},
	},
	{
		// Use default exports on plugins, routes and services so that we can autoload them
		files: ['src/plugins/*.ts', 'src/routes/**/*.ts', 'src/services/**/*.ts', '**/__mocks__/*.ts'],
		extends: [importPlugin.flatConfigs.recommended, importPlugin.flatConfigs.typescript],
		ignores: ['**/*.utils.ts', '**/*.types.ts'],
		rules: {
			'import/prefer-default-export': ['error', { target: 'single' }],
			'import/no-unresolved': 'off',
			'no-restricted-syntax': [
				'off',
				{
					selector: 'ExportDefaultDeclaration',
				},
			],
		},
	},
])
