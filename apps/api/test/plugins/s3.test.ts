import {
	CopyObjectCommand,
	DeleteObjectsCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3'

/**
 * Real secrets + s3 plugins; everything else mocked. Presigning is local (SigV4), no AWS call;
 * every other operation goes through `S3Client.send`, stubbed per test (`stubSend`) — no AWS call.
 */
const createApp = async (buckets: { artifacts?: string; preview?: string }) => {
	vi.stubEnv('AUTH_AUDIENCE', 'audience')
	vi.stubEnv('ANTHROPIC_API_KEY', '')
	vi.stubEnv('ANTHROPIC_API_KEY_SECRET_ARN', '')
	vi.stubEnv('AUTH_JWT_PRIVATE_KEY_SECRET_ARN', '')
	vi.stubEnv('ARTIFACTS_BUCKET', buckets.artifacts ?? '')
	vi.stubEnv('PREVIEW_BUCKET', buckets.preview ?? '')
	vi.stubEnv('AWS_ACCESS_KEY_ID', 'AKIATEST')
	vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'secret')
	vi.stubEnv('AWS_REGION', 'eu-north-1')
	vi.doUnmock('#/plugins/secrets.ts')
	vi.resetModules()
	return createTestApp({ skipMock: ['#/plugins/s3.ts', '#/plugins/secrets.ts'] })
}

type Command = { input: Record<string, unknown> }

/** Answers every `S3Client.send` from `answer`; records the commands in order */
const stubSend = (answer: (command: Command) => unknown) => {
	const commands: Command[] = []
	vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: Command) => {
		commands.push(command)
		return answer(command)
	}) as never)
	return commands
}

describe('S3 plugin (s3)', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	})

	it('Presigns a 15-minute GET URL on the artifacts bucket', async () => {
		// Arrange
		const app = await createApp({ artifacts: 'mf-artifacts-test' })

		// Act
		const url = new URL(await app.s3.presignDownload('deliverables/job-1/repo.zip'))

		// Assert
		expect(app.s3.configured).toBe(true)
		expect(url.host).toBe('mf-artifacts-test.s3.eu-north-1.amazonaws.com')
		expect(url.pathname).toBe('/deliverables/job-1/repo.zip')
		expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
		expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
	})

	it('Is unconfigured without any bucket and refuses to presign', async () => {
		// Arrange
		const app = await createApp({})

		// Act + Assert
		expect(app.s3.configured).toBe(false)
		await expect(app.s3.presignDownload('x')).rejects.toThrow(/ARTIFACTS_BUCKET/)
		await expect(app.s3.listObjects('b', 'p/')).resolves.toEqual([])
		await expect(app.s3.deletePrefix('b', 'p/')).resolves.toBe(0)
	})

	it('Serves the preview bucket without an artifacts bucket: listing works, artifacts refuse', async () => {
		// Arrange
		const app = await createApp({ preview: 'mf-preview' })
		stubSend(() => ({ Contents: [{ Key: 'preview/j/a.jpg', Size: 3 }], IsTruncated: false }))

		// Act + Assert
		expect(app.s3.configured).toBe(false)
		await expect(app.s3.listObjects('mf-preview', 'preview/j/')).resolves.toEqual([
			{ key: 'preview/j/a.jpg', size: 3 },
		])
		await expect(
			app.s3.copyToArtifacts({ bucket: 'mf-preview', key: 'preview/j/a.jpg' }, 'x')
		).rejects.toThrow(/ARTIFACTS_BUCKET/)
		await expect(app.s3.putArtifact('x', '{}', 'application/json')).rejects.toThrow(
			/ARTIFACTS_BUCKET/
		)
	})

	it('Lists every object under a prefix across continuation pages', async () => {
		// Arrange
		const app = await createApp({ artifacts: 'mf-artifacts-test', preview: 'mf-preview' })
		const commands = stubSend(command =>
			command.input.ContinuationToken === 'page-2'
				? { Contents: [{ Key: 'preview/j/c.jpg', Size: 3 }], IsTruncated: false }
				: {
						Contents: [
							{ Key: 'preview/j/a.jpg', Size: 1 },
							{ Key: 'preview/j/b.jpg', Size: 2 },
						],
						IsTruncated: true,
						NextContinuationToken: 'page-2',
					}
		)

		// Act
		const objects = await app.s3.listObjects('mf-preview', 'preview/j/')

		// Assert
		expect(objects).toEqual([
			{ key: 'preview/j/a.jpg', size: 1 },
			{ key: 'preview/j/b.jpg', size: 2 },
			{ key: 'preview/j/c.jpg', size: 3 },
		])
		expect(commands.every(command => command instanceof ListObjectsV2Command)).toBe(true)
		expect(commands.map(command => command.input)).toEqual([
			{ Bucket: 'mf-preview', Prefix: 'preview/j/', ContinuationToken: undefined },
			{ Bucket: 'mf-preview', Prefix: 'preview/j/', ContinuationToken: 'page-2' },
		])
	})

	it('Deletes a prefix in quiet batches of 1000 keys and resolves to the count', async () => {
		// Arrange
		const app = await createApp({ artifacts: 'mf-artifacts-test', preview: 'mf-preview' })
		const keys = Array.from({ length: 1001 }, (_, index) => `preview/j/${index}.jpg`)
		const commands = stubSend(command =>
			command instanceof ListObjectsV2Command
				? { Contents: keys.map(key => ({ Key: key, Size: 1 })), IsTruncated: false }
				: {}
		)

		// Act
		const deleted = await app.s3.deletePrefix('mf-preview', 'preview/j/')

		// Assert
		expect(deleted).toBe(1001)
		const deletes = commands.filter(command => command instanceof DeleteObjectsCommand)
		expect(deletes).toHaveLength(2)
		const batches = deletes.map(
			command => (command.input.Delete as { Objects: { Key: string }[]; Quiet: boolean }).Objects
		)
		expect(batches[0]).toHaveLength(1000)
		expect(batches[1]).toEqual([{ Key: 'preview/j/1000.jpg' }])
		expect(deletes.every(command => (command.input.Delete as { Quiet: boolean }).Quiet)).toBe(true)
		expect(deletes.every(command => command.input.Bucket === 'mf-preview')).toBe(true)
	})

	it('Rejects a partial deletion: per-key Errors from DeleteObjects are never a success', async () => {
		// Arrange — S3 answers 200 with an Errors list for a key the caller may not delete
		const app = await createApp({ artifacts: 'mf-artifacts-test', preview: 'mf-preview' })
		stubSend(command =>
			command instanceof ListObjectsV2Command
				? {
						Contents: [
							{ Key: 'preview/j/a.jpg', Size: 1 },
							{ Key: 'preview/j/locked.jpg', Size: 1 },
						],
						IsTruncated: false,
					}
				: { Errors: [{ Key: 'preview/j/locked.jpg', Code: 'AccessDenied' }] }
		)

		// Act + Assert
		await expect(app.s3.deletePrefix('mf-preview', 'preview/j/')).rejects.toThrow(
			/left 1 object\(s\) under mf-preview\/preview\/j\/: preview\/j\/locked.jpg \(AccessDenied\)/
		)
	})

	it('Copies into the artifacts bucket with an URL-encoded CopySource and reads the size back', async () => {
		// Arrange
		const app = await createApp({ artifacts: 'mf-artifacts-test', preview: 'mf-preview' })
		const commands = stubSend(command =>
			command instanceof HeadObjectCommand ? { ContentLength: 4321 } : {}
		)

		// Act
		const result = await app.s3.copyToArtifacts(
			{ bucket: 'mf-preview', key: 'preview/j/a b#c.jpg' },
			'deliverables/job-1/export/storage/a b#c.jpg'
		)

		// Assert
		expect(result).toEqual({ size: 4321 })
		const [copy, head] = commands
		expect(copy).toBeInstanceOf(CopyObjectCommand)
		expect(copy!.input).toEqual({
			Bucket: 'mf-artifacts-test',
			Key: 'deliverables/job-1/export/storage/a b#c.jpg',
			CopySource: 'mf-preview/preview/j/a%20b%23c.jpg',
		})
		expect(head).toBeInstanceOf(HeadObjectCommand)
		expect(head!.input).toEqual({
			Bucket: 'mf-artifacts-test',
			Key: 'deliverables/job-1/export/storage/a b#c.jpg',
		})
	})

	it('Writes a small artifact with its content type and resolves to the byte size', async () => {
		// Arrange
		const app = await createApp({ artifacts: 'mf-artifacts-test' })
		const commands = stubSend(() => ({}))

		// Act
		const result = await app.s3.putArtifact(
			'deliverables/job-1/export/x.md',
			'héj',
			'text/markdown'
		)

		// Assert
		expect(result).toEqual({ size: 4 })
		const [put] = commands
		expect(put).toBeInstanceOf(PutObjectCommand)
		expect(put!.input).toMatchObject({
			Bucket: 'mf-artifacts-test',
			Key: 'deliverables/job-1/export/x.md',
			ContentType: 'text/markdown',
		})
		expect(Buffer.from(put!.input.Body as Uint8Array).toString('utf8')).toBe('héj')
	})
})
