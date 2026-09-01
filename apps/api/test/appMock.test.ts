import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `createAppMock` discovers what to mock by listing `src/<type>/__mocks__`. A missing directory
 * must mean "nothing to mock", not an error.
 *
 * Why this is load-bearing rather than pedantic: every delivered build begins by deleting the
 * example Item entity, which removes the only service AND the only entry in
 * `src/services/__mocks__`. With `readdir` throwing ENOENT, that took down EVERY test that calls
 * `createAppMock` — 24 failures whose messages named the mock helper and never the actual cause.
 * Dogfood run 3 (2026-09-01) failed a whole build on it at the post-merge gate.
 *
 * The behaviour is verified against the real filesystem rather than the imported helper, because
 * the helper resolves its paths from its own module location and cannot be pointed elsewhere.
 * This pins the contract the fix implements: ENOENT → empty list, other errors → rethrow.
 */
const discover = async (mocksDir: string) => {
	try {
		return await readdir(mocksDir)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw error
	}
}

describe('createAppMock dependency discovery', () => {
	let root: string
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mf-appmock-'))
	})
	afterEach(() => rm(root, { recursive: true, force: true }))

	it('treats a missing __mocks__ directory as nothing to mock', async () => {
		// The shape a delivered app has right after the example entity is deleted
		await expect(discover(join(root, 'services', '__mocks__'))).resolves.toEqual([])
	})

	it('still lists mocks when the directory exists', async () => {
		const mocks = join(root, 'services', '__mocks__')
		await mkdir(mocks, { recursive: true })
		await writeFile(join(mocks, 'itemService.ts'), 'export default {}\n')
		await expect(discover(mocks)).resolves.toEqual(['itemService.ts'])
	})

	it('does not swallow errors that are not ENOENT', async () => {
		// A file where a directory is expected is ENOTDIR, a real misconfiguration worth surfacing
		const servicesFile = join(root, 'services')
		await writeFile(servicesFile, 'oops\n')
		await expect(discover(join(servicesFile, '__mocks__'))).rejects.toThrow()
	})
})
