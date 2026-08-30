import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Options = {
	skipMock?: string | string[]
}

const isValidFilename = (acc: string[], file: string) => {
	if (!file.endsWith('.ts')) return acc
	if (file.endsWith('.types.ts')) return acc
	if (file.endsWith('.utils.ts')) return acc
	return [...acc, file]
}

const getDependenciesToMock = async (type: 'plugins' | 'services') => {
	const testDir = dirname(fileURLToPath(import.meta.url))
	const srcDir = join(testDir, '..', 'src')
	const mocksDir = join(srcDir, type, '__mocks__')
	const allFiles = (await readdir(mocksDir)).reduce(isValidFilename, [])
	return allFiles.map(file => `#/${type}/${file}`)
}

/**
 * Builds a server where every plugin/service that has a `__mocks__` sibling is mocked,
 * except the ones listed in `skipMock` (which run their real implementation).
 */
export const createAppMock = async ({ skipMock }: Options = {}) => {
	const skipMocks = Array.isArray(skipMock) ? skipMock : [skipMock]

	// Dynamically mock plugins
	const plugins = await getDependenciesToMock('plugins')
	plugins.forEach(plugin => {
		if (skipMocks.includes(plugin)) return
		vi.doMock(plugin)
	})

	// Dynamically mock services
	const services = await getDependenciesToMock('services')
	services.forEach(service => {
		if (skipMocks.includes(service)) return
		vi.doMock(service)
	})

	const { createServer } = await import('../src/server.ts')
	return createServer({ logLevel: 'silent' })
}
