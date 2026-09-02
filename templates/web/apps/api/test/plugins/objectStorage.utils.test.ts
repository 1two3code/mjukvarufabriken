import { createMemoryObjectStorage, createS3ObjectStorage } from '#/plugins/objectStorage.utils.ts'

import type { S3Like } from '#/plugins/objectStorage.utils.ts'

/** Records every command sent, answers a canned object for gets */
const createFakeS3 = () => {
	const sent: { name: string; input: Record<string, unknown> }[] = []
	const client = {
		send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
			sent.push({ name: command.constructor.name, input: command.input })
			if (command.constructor.name === 'GetObjectCommand') {
				return {
					ContentType: 'image/png',
					Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
				}
			}
			return {}
		}),
		destroy: vi.fn(),
	} as unknown as S3Like
	return { client, sent }
}

describe('S3 object storage', () => {
	it('puts every key under the prefix — the only key space the app credentials may touch', async () => {
		// Arrange
		const { client, sent } = createFakeS3()
		const storage = createS3ObjectStorage('bucket', 'preview/abc123/', client)

		// Act
		await storage.put('photos/1.png', Buffer.from('x'), 'image/png')
		await storage.delete('/photos/1.png')

		// Assert
		expect(sent.map(entry => [entry.name, entry.input.Key])).toEqual([
			['PutObjectCommand', 'preview/abc123/photos/1.png'],
			['DeleteObjectCommand', 'preview/abc123/photos/1.png'],
		])
		expect(sent[0]!.input).toMatchObject({ Bucket: 'bucket', ContentType: 'image/png' })
	})

	it('reads an object back with its content type', async () => {
		const { client } = createFakeS3()
		const storage = createS3ObjectStorage('bucket', 'p/', client)

		await expect(storage.get('a.png')).resolves.toEqual({
			body: Buffer.from([1, 2, 3]),
			contentType: 'image/png',
		})
	})

	it('reports a missing object as undefined', async () => {
		const { client } = createFakeS3()
		vi.mocked(client.send).mockRejectedValueOnce(Object.assign(new Error('nope'), { name: 'NoSuchKey' }))
		const storage = createS3ObjectStorage('bucket', '', client)

		await expect(storage.get('missing')).resolves.toBeUndefined()
	})
})

describe('in-memory object storage', () => {
	it('round-trips objects and serves them as data URLs', async () => {
		const storage = createMemoryObjectStorage()
		await storage.put('a.txt', Buffer.from('hello'), 'text/plain')

		expect(await storage.get('a.txt')).toEqual({ body: Buffer.from('hello'), contentType: 'text/plain' })
		expect(await storage.url('a.txt')).toBe(`data:text/plain;base64,${Buffer.from('hello').toString('base64')}`)
		expect(await storage.delete('a.txt')).toBe(true)
		expect(await storage.get('a.txt')).toBeUndefined()
	})
})
