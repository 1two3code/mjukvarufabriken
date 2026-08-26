import { useEffect } from 'react'

import type { EffectCallback } from 'react'

/**
 * Use an effect only once.
 * Note that strict mode is still executing the effect twice.
 */
export function useEffectOnce(effect: EffectCallback) {
	// eslint-disable-next-line react-hooks/exhaustive-deps
	useEffect(effect, [])
}
