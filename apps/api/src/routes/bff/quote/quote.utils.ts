import { quoteTokenHeader, QuoteTokenSchema } from '@mf/models'

import type { IncomingHttpHeaders } from 'node:http'

/**
 * The quote token the site sends as `x-quote-token`; `undefined` when missing or malformed.
 * The routes answer 404 in that case, exactly as for a wrong token — a caller learns nothing
 * about whether the order exists.
 */
export const quoteTokenOf = (headers: IncomingHttpHeaders): string | undefined => {
	const raw = headers[quoteTokenHeader]
	const value = Array.isArray(raw) ? raw[0] : raw
	const parsed = QuoteTokenSchema.safeParse(value)
	return parsed.success ? parsed.data : undefined
}
