// Client-ip resolution for the ip-rate-limited public routes (`POST /bff/contact`,
// `GET /bff/showcases`): kept out of the route plugin so another route can import it without
// evaluating the contact route (or its env read) as a side effect.

/**
 * Number of trusted proxies that append to `x-forwarded-for` in front of the api. In AWS it is
 * CloudFront → ALB (2); override with `TRUSTED_PROXY_HOPS` (e.g. 1 when calling the ALB directly).
 */
export const trustedProxyHops = Math.max(1, Number(process.env.TRUSTED_PROXY_HOPS) || 2)

/**
 * The client ip behind the proxies: every proxy APPENDS the address it saw, so anything the
 * caller put in the header itself sits to the left of the last `hops` entries and is ignored.
 * With fewer entries than hops the leftmost one is still proxy-added. No header → socket ip.
 */
export const clientIp = (
	forwardedFor: string | string[] | undefined,
	fallback: string,
	hops = trustedProxyHops
) => {
	const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor
	const entries = (header ?? '')
		.split(',')
		.map(entry => entry.trim())
		.filter(Boolean)
	if (!entries.length) return fallback
	return entries[Math.max(0, entries.length - hops)]!.slice(0, 64)
}
