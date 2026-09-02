import type { FastifyInstance } from 'fastify'

describe('Store plugin (store)', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		vi.stubEnv('DATABASE_URL', '')
		app = await createTestApp({ skipMock: '#/plugins/store.ts' })
	})

	afterEach(() => vi.unstubAllEnvs())

	it('Runs in memory when no DATABASE_URL is set', () => {
		expect(app.store.kind).toBe('memory')
	})

	it('Is durable on Postgres when DATABASE_URL is set', async () => {
		// Arrange — nothing connects until the first operation, so no server is needed
		vi.stubEnv('DATABASE_URL', 'postgres://app:secret@localhost:5432/app')

		// Act
		const durable = await createTestApp({ skipMock: '#/plugins/store.ts' })

		// Assert
		expect(durable.store.kind).toBe('postgres')
		await durable.close()
	})

	it('Returns undefined for unknown keys', async () => {
		// Arrange
		// Act
		const result = await app.store.get('items', 'missing')

		// Assert
		expect(result).toBeUndefined()
	})

	it('Stores and lists values per collection', async () => {
		// Arrange
		await app.store.put('items', '1', { id: '1' })
		await app.store.put('items', '2', { id: '2' })
		await app.store.put('users', '1', { id: 'u1' })

		// Act
		const items = await app.store.list('items')
		const user = await app.store.get('users', '1')

		// Assert
		expect(items).toEqual([{ id: '1' }, { id: '2' }])
		expect(user).toEqual({ id: 'u1' })
	})

	it('Returns copies so callers cannot mutate stored values', async () => {
		// Arrange
		const value = { id: '1', tags: ['a'] }
		await app.store.put('items', '1', value)
		value.tags.push('b')

		// Act
		const stored = await app.store.get<typeof value>('items', '1')
		stored!.tags.push('c')
		const storedAgain = await app.store.get<typeof value>('items', '1')

		// Assert
		expect(storedAgain?.tags).toEqual(['a'])
	})

	it('Deletes values', async () => {
		// Arrange
		await app.store.put('items', '1', { id: '1' })

		// Act
		const deleted = await app.store.delete('items', '1')
		const deletedAgain = await app.store.delete('items', '1')

		// Assert
		expect(deleted).toBe(true)
		expect(deletedAgain).toBe(false)
		expect(await app.store.list('items')).toEqual([])
	})
})
