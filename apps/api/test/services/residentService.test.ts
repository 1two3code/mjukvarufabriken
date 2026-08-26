import { createMockResidentUsageRecord } from '#/services/__mocks__/residentService.ts'
import { installationOf, ResidentUnauthorized } from '#/services/residentService.ts'

import type { FastifyInstance } from 'fastify'

describe('Resident Service', () => {
	let app: FastifyInstance

	beforeEach(async () => {
		app = await createTestApp({ skipMock: '#/services/residentService.ts' })
		app.secrets.residentInstallations = { 'acme-shop': 'token-a', 'beta-crm': 'token-b' }
	})

	it('Resolves an installation token and rejects unknown ones', async () => {
		expect(await app.residentService.authenticate('token-b')).toBe('beta-crm')
		await expect(app.residentService.authenticate('nope')).rejects.toThrow(ResidentUnauthorized)
		await expect(app.residentService.authenticate(undefined)).rejects.toThrow(ResidentUnauthorized)
		expect(installationOf({}, 'token-a')).toBeUndefined()
	})

	it('Stores one record per installation and day, last write wins, newest first', async () => {
		// Arrange
		const monday = createMockResidentUsageRecord({ day: '2026-09-07' })
		const tuesday = createMockResidentUsageRecord({ day: '2026-09-08', totalTokens: 10 })
		const tuesdayAgain = createMockResidentUsageRecord({ day: '2026-09-08', totalTokens: 20 })
		const other = createMockResidentUsageRecord({ installationId: 'beta-crm', day: '2026-09-09' })

		// Act
		expect(await app.residentService.recordUsage(monday)).toEqual({
			id: 'acme-shop/2026-09-07',
			stored: true,
		})
		await app.residentService.recordUsage(tuesday)
		await app.residentService.recordUsage(tuesdayAgain)
		await app.residentService.recordUsage(other)

		// Assert
		const acme = await app.residentService.listUsage('acme-shop')
		expect(acme.map(record => [record.day, record.totalTokens])).toEqual([
			['2026-09-08', 20],
			['2026-09-07', 1_100_000],
		])
		expect(await app.residentService.listUsage()).toHaveLength(3)
		// The installation row exists from the first record, unlinked until an admin links it
		expect(await app.residentService.listInstallations()).toMatchObject([
			{ id: 'beta-crm' },
			{ id: 'acme-shop' },
		])
	})

	it('Summarises the month per installation with its org and provider report', async () => {
		// Arrange
		await app.residentService.recordUsage(createMockResidentUsageRecord({ day: '2026-09-01' }))
		await app.residentService.recordUsage(createMockResidentUsageRecord({ day: '2026-09-02' }))
		await app.residentService.recordUsage(
			createMockResidentUsageRecord({ day: '2026-10-01', month: '2026-10' })
		)
		await app.residentService.upsertInstallation('acme-shop', {
			orgId: 'org-1',
			billingCustomerId: 'cus_1',
		})
		await app.db.resident.upsertUsageReport({
			installationId: 'acme-shop',
			month: '2026-09',
			usdCents: 1_350,
			provider: 'stripe',
			reference: 'mtr_1',
		})

		// Act
		const september = await app.residentService.summarizeUsage({ month: '2026-09' })
		const all = await app.residentService.summarizeUsage()

		// Assert
		expect(september).toEqual([
			expect.objectContaining({
				installationId: 'acme-shop',
				orgId: 'org-1',
				month: '2026-09',
				days: 2,
				totalTokens: 2_200_000,
				billableUsd: 13.5,
				report: expect.objectContaining({ usdCents: 1_350, reference: 'mtr_1' }),
			}),
		])
		expect(all.map(summary => [summary.month, summary.report?.usdCents])).toEqual([
			['2026-10', undefined],
			['2026-09', 1_350],
		])
	})

	it('Keeps installation fields not mentioned and clears null ones', async () => {
		await app.residentService.upsertInstallation('acme-shop', {
			orgId: 'org-1',
			billingCustomerId: 'cus_1',
		})
		const cleared = await app.residentService.upsertInstallation('acme-shop', {
			billingCustomerId: null,
		})

		expect(cleared).toMatchObject({ id: 'acme-shop', orgId: 'org-1' })
		expect(cleared.billingCustomerId).toBeUndefined()
	})
})
