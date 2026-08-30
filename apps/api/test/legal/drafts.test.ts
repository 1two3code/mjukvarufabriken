import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { customerCancellableOrderStatus } from '@mf/models'

import { githubScope } from '#/plugins/githubOAuth.ts'
import { magicLinkTtlMinutes, refreshTokenTtlDays } from '#/services/authService.ts'
import { contactRateLimit } from '#/services/contactService.ts'
import { orgNameFromEmail } from '#/services/userService.utils.ts'

const root = resolve(import.meta.dirname, '../../../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

const drafts = {
	kundavtal: read('legal/kundavtal.md'),
	pubAvtal: read('legal/pub-avtal.md'),
	slaResident: read('legal/sla-resident.md'),
	villkorWebb: read('legal/villkor-webb.md'),
}

/** The bracketed open points are allowed to mention things that are not built yet */
const withoutOpenPoints = (text: string) => text.replace(/_\[Öppen punkt[^\]]*\]_/gs, '')

/**
 * The legal drafts state facts about the product (retention, login methods, cancellation, token
 * cap). These checks keep the drafts from drifting away from the code they describe.
 */
describe('Legal drafts vs. code', () => {
	it('Every draft is marked DRAFT — EJ GRANSKAD under every numbered heading', () => {
		for (const text of Object.values(drafts)) {
			const headings = text.match(/^## \d+\./gm) ?? []
			const markers = text.match(/^_DRAFT — EJ GRANSKAD_$/gm) ?? []
			expect(headings.length).toBeGreaterThan(0)
			expect(markers.length).toBe(headings.length)
		}
	})

	it('Describes both login methods the api has: magic link and GitHub sign-in', () => {
		for (const route of ['requestMagicLink', 'verifyMagicLink', 'github', 'githubCallback']) {
			expect(() => read(`apps/api/src/routes/bff/auth/${route}.ts`)).not.toThrow()
		}

		expect(withoutOpenPoints(drafts.villkorWebb)).toMatch(/inloggning med GitHub/i)
		expect(drafts.villkorWebb).toContain(`\`${githubScope}\``)
	})

	it('States the token lifetimes the api uses', () => {
		expect(drafts.villkorWebb).toContain(`giltiga i ${magicLinkTtlMinutes} minuter`)
		expect(drafts.villkorWebb).toContain(`uppdateringsbevis ${refreshTokenTtlDays} dagar`)
	})

	it('States the contact-form ip retention as an upper bound matching the limiter window', () => {
		expect(drafts.villkorWebb).toContain(`högst ${contactRateLimit.windowMinutes} minuter`)
		expect(drafts.villkorWebb).not.toMatch(/IP-räknaren i minst/)
	})

	it('Describes org naming the way userService derives it', () => {
		expect(orgNameFromEmail('anna@acme.se')).toBe('acme.se')
		expect(orgNameFromEmail('anna.svensson@gmail.com')).toBe('anna.svensson')
		expect(drafts.villkorWebb).toMatch(/allmän e-postleverantör/)
		expect(drafts.villkorWebb).toMatch(/står före\s+`@`/)
		expect(drafts.villkorWebb).not.toMatch(/första användaren från en domän/)
	})

	it('Customer self-cancellation stops where the order state machine stops it', () => {
		// Customers cancel in the portal until the deposit is paid; later states need the supplier
		expect(customerCancellableOrderStatus).toEqual(['drafting', 'ready', 'frozen'])
		expect(drafts.kundavtal).toMatch(
			/Innan förskottet betalats\*\* får Kunden avbryta beställningen utan kostnad, själv i\s+portalen/
		)
		expect(drafts.kundavtal).toMatch(/Efter att förskottet betalats men innan bygget påbörjats/)
		expect(drafts.kundavtal).toMatch(
			/Efter att bygget påbörjats\*\* får Kunden avbryta genom skriftligt meddelande/
		)
	})

	it('Final payment falls due at acceptance and does not itself count as acceptance', () => {
		expect(drafts.kundavtal).toMatch(/förfaller till betalning när leveransen accepterats/)
		expect(drafts.kundavtal).toContain('Slutbetalning i sig utgör inte acceptans.')
	})

	it('Supplier cancellation on budget exhaustion requires the §4.2 retry first', () => {
		expect(drafts.kundavtal).toMatch(/minst ett förnyat försök/)
		expect(drafts.kundavtal).toMatch(/efter förnyat försök enligt punkt 4\.2/)
	})

	it('Retention of supplier copies is the same in the customer agreement and the DPA', () => {
		expect(drafts.kundavtal).toMatch(/tolv \(12\) månader förflutit från acceptans/)
		expect(drafts.pubAvtal).toMatch(/senast\s+tolv \(12\) månader efter acceptans/)
		expect(drafts.pubAvtal).not.toMatch(/nittio \(90\) dagar/)
	})

	it('Resident overshoot promise accounts for parallel workers and names the real default', () => {
		const config = read('packages/resident/src/config.ts')
		const defaultWorkers = /RESIDENT_TASK_WORKERS, (\d+)\)/.exec(config)?.[1]
		expect(defaultWorkers).toBe('2')
		expect(drafts.slaResident).toMatch(/högst en modellvändning per parallell arbetare/)
		expect(drafts.slaResident).toContain('`RESIDENT_TASK_WORKERS`,\nstandard två')
	})
})
