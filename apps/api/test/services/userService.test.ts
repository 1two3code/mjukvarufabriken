import { EntityNotFound } from '#/lib/entityError.ts'
import { createMockOrg, createMockUser } from '#/services/__mocks__/userService.ts'
import { orgNameFromEmail } from '#/services/userService.utils.ts'

import type { FastifyInstance } from 'fastify'

describe('User Service', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/services/userService.ts' })
	})

	describe('orgNameFromEmail', () => {
		it.each([
			['anna@acme.se', 'acme.se'],
			['Bob@Example.COM', 'example.com'],
			['hasse.lofgren@outlook.com', 'hasse.lofgren'],
			['someone@gmail.com', 'someone'],
			['x@icloud.com', 'x'],
		])('Derives the org name from %s', (email, expected) => {
			expect(orgNameFromEmail(email)).toBe(expected)
		})
	})

	describe('findOrCreateByEmail', () => {
		it('Creates an org named after the email domain and a user on first sign-in', async () => {
			// Act
			const user = await app.userService.findOrCreateByEmail('Anna@Acme.se')
			const org = await app.userService.getOrg(user.orgId)

			// Assert
			expect(user).toEqual({
				id: expect.any(String),
				email: 'anna@acme.se',
				role: 'user',
				orgId: org.id,
				createdAt: expect.any(String),
			})
			expect(org.name).toBe('acme.se')
		})

		it('Returns the existing user (case-insensitive) without creating another org', async () => {
			// Arrange
			const first = await app.userService.findOrCreateByEmail('anna@acme.se')

			// Act
			const second = await app.userService.findOrCreateByEmail('ANNA@acme.se')
			const orgs = await app.db.users.listOrgs()

			// Assert
			expect(second).toEqual(first)
			expect(orgs).toHaveLength(1)
		})

		it('Returns the winner when two first sign-ins for the same email race', async () => {
			// Arrange — both requests miss the lookup before either has inserted
			const findByEmail = vi.spyOn(app.db.users, 'findByEmail')
			findByEmail.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)

			// Act
			const [first, second] = await Promise.all([
				app.userService.findOrCreateByEmail('anna@acme.se'),
				app.userService.findOrCreateByEmail('anna@acme.se'),
			])
			const orgs = await app.db.users.listOrgs()

			// Assert — one user, one org, no 23505 leaking out as a 500
			expect(second).toEqual(first)
			expect(orgs).toHaveLength(1)
		})

		it('Rethrows insert failures that are not a unique violation', async () => {
			// Arrange
			vi.spyOn(app.db.users, 'insertWithOrg').mockRejectedValue(new Error('connection reset'))

			// Act & Assert
			await expect(app.userService.findOrCreateByEmail('anna@acme.se')).rejects.toThrow(
				'connection reset'
			)
		})

		it('Grants the admin role to emails in AUTH_ADMIN_EMAILS', async () => {
			// Arrange
			const [adminEmail] = app.secrets.authAdminEmails

			// Act
			const admin = await app.userService.findOrCreateByEmail(adminEmail!.toUpperCase())
			const user = await app.userService.findOrCreateByEmail('someone@else.se')

			// Assert
			expect(admin.role).toBe('admin')
			expect(user.role).toBe('user')
		})
	})

	describe('get / getOrg', () => {
		it('Returns stored entities and throws EntityNotFound otherwise', async () => {
			// Arrange
			const org = await app.db.users.insertOrg({ name: createMockOrg().name })
			const user = await app.db.users.insert({ ...createMockUser(), orgId: org.id })

			// Act & Assert
			await expect(app.userService.get(user.id)).resolves.toEqual(user)
			await expect(app.userService.getOrg(org.id)).resolves.toEqual(org)
			await expect(app.userService.get('missing')).rejects.toBeInstanceOf(EntityNotFound)
			await expect(app.userService.getOrg('missing')).rejects.toBeInstanceOf(EntityNotFound)
		})
	})
})
