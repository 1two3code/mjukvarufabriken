import { createHash, randomBytes } from 'node:crypto'

import { anonymousOrgPrefix, isSpecComplete } from '@mf/models'

import type { Quote, SpecDraft } from '@mf/models'

/**
 * The quote token: 32 random bytes as 64 hex chars (`QuoteTokenSchema`), returned once by
 * `POST /bff/quote` and held by the visitor's browser. Only its sha256 is stored (0025), so a
 * database read never yields a usable token — the same shape as the job report token.
 */
export const mintQuoteToken = () => randomBytes(32).toString('hex')
export const hashQuoteToken = (token: string) => createHash('sha256').update(token).digest('hex')

/** A fresh anonymous owner id: `anon:` + 32 random hex — never collides with a real org uuid */
export const mintAnonymousOrgId = () => `${anonymousOrgPrefix}${randomBytes(16).toString('hex')}`

/**
 * What the site sees of an anonymous draft. The engine sets `spec.sizeClass` and `priceSek` on
 * every completing turn, so the quote is fixed exactly when the spec is complete — and only then:
 * an incomplete spec has no price even if an earlier turn had one.
 */
export const toQuote = (draft: SpecDraft): Quote => {
	const complete = isSpecComplete(draft.spec)
	return {
		orderId: draft.orderId,
		status: draft.status,
		spec: draft.spec,
		messages: draft.messages,
		openQuestions: draft.openQuestions,
		complete,
		priceSek: complete ? draft.priceSek : undefined,
		sizeClass: complete ? draft.spec.sizeClass : undefined,
	}
}
