/**
 * Mail providers whose domain says nothing about the customer's organisation. For these the
 * org is named after the local part of the address instead of the domain.
 */
export const publicMailDomains = new Set([
	'gmail.com',
	'googlemail.com',
	'outlook.com',
	'hotmail.com',
	'hotmail.se',
	'live.com',
	'live.se',
	'msn.com',
	'icloud.com',
	'me.com',
	'yahoo.com',
	'yahoo.se',
	'protonmail.com',
	'proton.me',
	'telia.com',
	'spray.se',
])

export const normalizeEmail = (email: string) => email.trim().toLowerCase()

/** Derives a default org name from an email address, e.g. `anna@acme.se` → `acme.se` */
export const orgNameFromEmail = (email: string) => {
	const [localPart = '', domain = ''] = normalizeEmail(email).split('@')
	return publicMailDomains.has(domain) ? localPart : domain
}

export const isAdminEmail = (email: string, adminEmails: string[]) =>
	adminEmails.includes(normalizeEmail(email))
