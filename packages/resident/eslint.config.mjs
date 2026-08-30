import { defineConfig } from 'eslint/config'

// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import baseConfig from '../../eslint.config.mjs'

// eslint-disable-next-line no-restricted-syntax
export default defineConfig(...baseConfig)
