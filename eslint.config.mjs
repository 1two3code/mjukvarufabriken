import eslintConfigPrettier from 'eslint-config-prettier'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'
import eslint from '@eslint/js'

// eslint-disable-next-line no-restricted-syntax
export default defineConfig(
	eslint.configs.recommended,
	tseslint.configs.recommended,
	eslintConfigPrettier,

	// Custom rules
	{
		rules: {
			curly: ['error', 'multi-line'],
			'no-restricted-syntax': [
				'error',
				{
					selector: 'ExportDefaultDeclaration',
					message: 'Prefer named exports',
				},
			],
			'@typescript-eslint/no-unused-vars': ['warn', { ignoreRestSiblings: true }],
			// Node executes .ts with type stripping only: parameter properties (and enums, namespaces)
			// are transforms it refuses at boot — vitest/esbuild would hide the crash until deploy
			'@typescript-eslint/parameter-properties': ['error', { prefer: 'class-property' }],
			'@typescript-eslint/consistent-type-imports': [
				'error',
				{ fixStyle: 'separate-type-imports' },
			],
			'@typescript-eslint/no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['../*'],
							message: 'Usage of relative parent imports is not allowed.',
						},
					],
				},
			],
		},
	},
	// Overrides
	{
		files: ['**/*.test.ts', '**/*/__mocks__/*'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
		},
	}
)
