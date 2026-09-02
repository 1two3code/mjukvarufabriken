import { createPostgresStore, ensureTableSql } from '#/plugins/store.utils.ts'

import type { Query } from '#/plugins/store.utils.ts'

/**
 * The Postgres backend is verified over a recording fake of `query`, so the tests need no
 * server: they pin the statements and parameters sent, and the mapping of rows back to values.
 */
type Sent = { text: string; params: unknown[] }

const createFakeQuery = (rows: Record<string, unknown>[][] = []) => {
	const sent: Sent[] = []
	const query: Query = async (text, params = []) => {
		sent.push({ text, params })
		return text === ensureTableSql ? [] : (rows.shift() ?? [])
	}
	return { query, sent }
}

describe('Postgres store backend', () => {
	it('creates its table once, before the first operation, and never again', async () => {
		// Arrange
		const { query, sent } = createFakeQuery([[], []])
		const store = createPostgresStore(query, async () => {})

		// Act
		await store.get('items', '1')
		await store.list('items')

		// Assert
		const creates = sent.filter(entry => entry.text === ensureTableSql)
		expect(creates).toHaveLength(1)
		expect(sent[0]!.text).toBe(ensureTableSql)
		expect(ensureTableSql).toMatch(/CREATE TABLE IF NOT EXISTS/)
	})

	it('reads a value by collection and id with bound parameters', async () => {
		// Arrange
		const { query, sent } = createFakeQuery([[{ value: { id: '1', name: 'one' } }]])
		const store = createPostgresStore(query, async () => {})

		// Act
		const value = await store.get('items', '1')

		// Assert
		expect(value).toEqual({ id: '1', name: 'one' })
		expect(sent.at(-1)).toEqual({
			text: expect.stringMatching(/SELECT value FROM store WHERE collection = \$1 AND id = \$2/),
			params: ['items', '1'],
		})
	})

	it('returns undefined for an unknown id', async () => {
		// Arrange
		const { query } = createFakeQuery([[]])
		const store = createPostgresStore(query, async () => {})

		// Act + Assert
		await expect(store.get('items', 'missing')).resolves.toBeUndefined()
	})

	it('lists a collection in insertion order', async () => {
		// Arrange
		const { query, sent } = createFakeQuery([[{ value: { id: '1' } }, { value: { id: '2' } }]])
		const store = createPostgresStore(query, async () => {})

		// Act
		const items = await store.list('items')

		// Assert
		expect(items).toEqual([{ id: '1' }, { id: '2' }])
		expect(sent.at(-1)!.text).toMatch(/ORDER BY created_at, id/)
		expect(sent.at(-1)!.params).toEqual(['items'])
	})

	it('upserts on put so a second write to the same id replaces the value', async () => {
		// Arrange
		const { query, sent } = createFakeQuery()
		const store = createPostgresStore(query, async () => {})

		// Act
		await store.put('items', '1', { id: '1', tags: ['a'] })

		// Assert
		const last = sent.at(-1)!
		expect(last.text).toMatch(/INSERT INTO store/)
		expect(last.text).toMatch(/ON CONFLICT \(collection, id\) DO UPDATE SET value = EXCLUDED.value/)
		expect(last.params).toEqual(['items', '1', JSON.stringify({ id: '1', tags: ['a'] })])
	})

	it('reports whether a delete removed anything', async () => {
		// Arrange
		const { query } = createFakeQuery([[{ id: '1' }], []])
		const store = createPostgresStore(query, async () => {})

		// Act + Assert
		await expect(store.delete('items', '1')).resolves.toBe(true)
		await expect(store.delete('items', '1')).resolves.toBe(false)
	})

	it('closes the connection it was given', async () => {
		// Arrange
		const close = vi.fn().mockResolvedValue(undefined)
		const store = createPostgresStore(createFakeQuery().query, close)

		// Act
		await store.close()

		// Assert
		expect(close).toHaveBeenCalledOnce()
	})
})
