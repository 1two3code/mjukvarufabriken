import { DatabaseNotConfigured } from '#/plugins/db.ts'

import type { FastifyInstance } from 'fastify'

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
		expect(sendMock).not.toHaveBeenCalled()
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
