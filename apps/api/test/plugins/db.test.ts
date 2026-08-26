import { DatabaseNotConfigured } from '#/plugins/db.ts'

import type { FastifyInstance } from 'fastify'
import type * as mfDb from '@mf/db'

// Migrations are mocked: no Postgres in the test suite
const migrateMock = vi.hoisted(() => vi.fn())
vi.mock('@mf/db', async importOriginal => ({
	...(await importOriginal<typeof mfDb>()),
	migrate: migrateMock,
}))

// Clearly mocked: no real AWS calls are made in this suite.
const sendMock = vi.hoisted(() => vi.fn())
vi.mock('@aws-sdk/client-secrets-manager', () => ({
	SecretsManagerClient: class {
		send = sendMock
		destroy = vi.fn()
	},
	GetSecretValueCommand: class {
		constructor(public input: unknown) {}
	},
}))

describe('Db plugin (db)', () => {
	let app: FastifyInstance

	beforeEach(() => {
		migrateMock.mockReset().mockResolvedValue({ applied: [], skipped: [] })
	})
	afterEach(async () => {
		vi.unstubAllEnvs()
		await app?.close()
	})

	it('Boots without a database and rejects every repository call', async () => {
		// Arrange
		vi.stubEnv('DATABASE_URL', '')
		vi.stubEnv('DATABASE_SECRET_ARN', '')

		// Act
		app = await createTestApp({ skipMock: '#/plugins/db.ts' })

		// Assert
		expect(app.db.available).toBe(false)
		await expect(app.db.jobs.get('job-1')).rejects.toBeInstanceOf(DatabaseNotConfigured)
		await expect(app.db.jobs.list()).rejects.toBeInstanceOf(DatabaseNotConfigured)
	})

	it('Creates a client from DATABASE_URL (lazy connection)', async () => {
		// Arrange
		vi.stubEnv('DATABASE_URL', 'postgres://mf:mf@localhost:1/mf')

		// Act
		app = await createTestApp({ skipMock: '#/plugins/db.ts' })

		// Assert
		expect(app.db.available).toBe(true)
		expect(app.db.error).toBeUndefined()
		expect(migrateMock).toHaveBeenCalledTimes(1)
		expect(sendMock).not.toHaveBeenCalled()
	})

	it('Is unavailable (and says why) when migrations fail instead of masking it', async () => {
		// Arrange
		vi.stubEnv('DATABASE_URL', 'postgres://mf:mf@localhost:1/mf')
		migrateMock.mockRejectedValue(new Error('syntax error at or near "alter"'))

		// Act
		app = await createTestApp({ skipMock: '#/plugins/db.ts' })

		// Assert
		expect(app.db.available).toBe(false)
		expect(app.db.error).toMatch(/syntax error/)
		const error = await app.db.jobs.get('job-1').catch((cause: Error) => cause)
		expect(error).toMatchObject({
			name: 'Error',
			message: 'Database unavailable: migrations failed (syntax error at or near "alter")',
		})
	})

	it('Builds the connection string from the RDS secret', async () => {
		// Arrange
		vi.stubEnv('DATABASE_URL', '')
		vi.stubEnv('DATABASE_SECRET_ARN', 'arn:aws:secretsmanager:eu-north-1:1:secret:rds')
		sendMock.mockResolvedValue({
			SecretString: JSON.stringify({
				username: 'mf',
				password: 'p@ss',
				host: 'db.internal',
				port: 5432,
				dbname: 'mf',
			}),
		})

		// Act
		app = await createTestApp({ skipMock: '#/plugins/db.ts' })

		// Assert
		expect(app.db.available).toBe(true)
		expect(sendMock).toHaveBeenCalledTimes(1)
	})

	it('Degrades to unavailable when the secret cannot be read', async () => {
		// Arrange
		vi.stubEnv('DATABASE_URL', '')
		vi.stubEnv('DATABASE_SECRET_ARN', 'arn:aws:secretsmanager:eu-north-1:1:secret:rds')
		sendMock.mockRejectedValue(new Error('AccessDenied'))

		// Act
		app = await createTestApp({ skipMock: '#/plugins/db.ts' })

		// Assert
		expect(app.db.available).toBe(false)
	})
})
