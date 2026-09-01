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
	// A missing `__mocks__` directory means "nothing of this type to mock", never a failure. An app
	// legitimately has no services yet — every delivered build starts by deleting the example Item
	// entity, which removes the only service AND the only service mock. Before this, `readdir` threw
	// ENOENT and took EVERY test using `createAppMock` down with it: 24 failures whose message says
	// nothing about the actual cause. Found by dogfood run 3 (2026-09-01), where it failed the whole
	// build at the post-merge gate.
	try {
		const entries = await readdir(mocksDir)
		return entries.reduce(isValidFilename, []).map(file => `#/${type}/${file}`)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw error
	}
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
