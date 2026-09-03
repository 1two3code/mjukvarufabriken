/**
 * The visitor's handle on their anonymous quote: the order id and the token `POST /bff/quote`
 * returned once. Kept in this origin's localStorage so a refresh (or coming back tomorrow)
 * resumes the draft; the api forgets unclaimed quotes after 30 days, and a claimed one answers
 * 404, so a stale handle simply fails to resume and is cleared.
 */
export type QuoteHandle = { orderId: string; token: string }

const storageKey = 'quote'

const isHandle = (value: unknown): value is QuoteHandle =>
	typeof value === 'object' &&
	value != null &&
	typeof (value as QuoteHandle).orderId === 'string' &&
	typeof (value as QuoteHandle).token === 'string'

export const readQuoteHandle = (): QuoteHandle | null => {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
		return isHandle(parsed) ? parsed : null
	} catch {
		return null
	}
}

export const writeQuoteHandle = (handle: QuoteHandle) =>
	localStorage.setItem(storageKey, JSON.stringify(handle))

export const clearQuoteHandle = () => localStorage.removeItem(storageKey)

/** Where "Save / order this" sends the visitor: the portal's login, then straight to the claim */
export const claimUrl = ({ orderId, token }: QuoteHandle) => {
	const claim = `/claim?order=${encodeURIComponent(orderId)}&token=${encodeURIComponent(token)}`
	return `${import.meta.env.VITE_PORTAL_URL}/login?redirect=${encodeURIComponent(claim)}`
}
