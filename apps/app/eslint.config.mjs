import reactHooks from 'eslint-plugin-react-hooks'
import { defineConfig } from 'eslint/config'

// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import baseConfig from '../../eslint.config.mjs'

// eslint-disable-next-line no-restricted-syntax
export default defineConfig(...baseConfig, {
	plugins: {
		'react-hooks': reactHooks,
	},
	rules: {
		'react-hooks/rules-of-hooks': 'error',
		'react-hooks/exhaustive-deps': 'warn',
		'jsx-quotes': ['error', 'prefer-double'],
		'@typescript-eslint/no-restricted-imports': [
			'error',
			{
				patterns: [
					{
						group: ['../*'],
						message: 'Usage of relative parent imports is not allowed.',
					},
				],
				paths: [
					{
						name: 'react-redux',
						importNames: ['useSelector', 'useStore', 'useDispatch'],
						message: 'Please use pre-typed versions from `app/hooks.ts` instead.',
					},
					{
						name: '@reduxjs/toolkit/query/react',
						importNames: ['createApi'],
						message: 'Please use application specific api from `app/api.ts` instead.',
					},
				],
			},
		],
	},
})
