import { createHash, randomBytes } from 'node:crypto'

/** Opaque, URL-safe token (32 random bytes). Only its hash is ever stored. */
export const generateToken = () => randomBytes(32).toString('base64url')

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')

export const addMinutes = (date: Date, minutes: number) =>
	new Date(date.getTime() + minutes * 60 * 1000)

export const addDays = (date: Date, days: number) => addMinutes(date, days * 24 * 60)

export const isExpired = (expiresAt: string, now = new Date()) => new Date(expiresAt) <= now

export const buildMagicLink = (portalUrl: string, token: string) => {
	const url = new URL('/auth/callback', portalUrl)
	url.searchParams.set('token', token)
	return url.toString()
}

export const magicLinkEmail = (link: string, portalUrl: string) => ({
	subject: 'Logga in på Mjukvaruhuset / Sign in to Mjukvaruhuset',
	text: [
		'Klicka på länken för att logga in (giltig i 15 minuter, kan bara användas en gång):',
		'Click the link to sign in (valid for 15 minutes, single use):',
		'',
		link,
		'',
		`Om du inte bad om detta kan du ignorera mejlet. / If you did not request this, ignore this email.`,
		portalUrl,
	].join('\n'),
	html: [
		'<p>Klicka på länken för att logga in (giltig i 15 minuter, kan bara användas en gång):<br>',
		'Click the link to sign in (valid for 15 minutes, single use):</p>',
		`<p><a href="${link}">${link}</a></p>`,
		'<p>Om du inte bad om detta kan du ignorera mejlet. / If you did not request this, ignore this email.</p>',
	].join('\n'),
})
