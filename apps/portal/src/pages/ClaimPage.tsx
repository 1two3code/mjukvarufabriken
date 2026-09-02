import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { QuoteTokenSchema } from '@mf/models'

import { useEffectOnce } from '#/hooks/useEffectOnce.ts'
import { useClaimOrderMutation } from '#/features/orders/ordersApiSlice.ts'

import { Spinner } from '#/components/Spinner.tsx'

/**
 * Landing page of the site's "save / order this" button (`/claim?order=…&token=…`, behind the
 * session): claims the anonymous quote for the signed-in org and continues to its spec page.
 * The token is single use — never claim twice (React strict mode runs effects twice).
 */
export function ClaimPage() {
	const { t } = useTranslation()
	const [searchParams] = useSearchParams()
	const [claimOrder, { error }] = useClaimOrderMutation()
	const [claimedId, setClaimedId] = useState<string | null>(null)
	const started = useRef(false)

	const orderId = searchParams.get('order')
	const token = QuoteTokenSchema.safeParse(searchParams.get('token'))
	const valid = orderId !== null && token.success

	useEffectOnce(() => {
		if (!valid || started.current) return
		started.current = true
		claimOrder({ orderId, token: token.data }).then(result => {
			if (!result.error) setClaimedId(result.data.id)
		})
	})

	if (claimedId) return <Navigate to={`/orders/${claimedId}/spec`} replace />

	if (!valid || error) {
		return (
			<>
				<h1>{t('page.claim.error.title')}</h1>
				<p>{t('page.claim.error.body')}</p>
				<p>
					<Link to="/orders">{t('page.claim.action.orders')}</Link>
				</p>
			</>
		)
	}

	return (
		<>
			<h1>{t('page.claim.title')}</h1>
			<Spinner center />
		</>
	)
}
