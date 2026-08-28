import { generateKeyPairSync, randomBytes } from 'node:crypto'

/**
 * Runtime secrets a delivered app commonly requires but that the customer doesn't provide up front:
 * a JWT signing secret and a web-push VAPID keypair. Both the boot smoke-check and the real ECS
 * Express deploy generate these so a well-formed app actually starts (the family-hub delivery
 * crash-looped precisely because the deploy injected only the auth contract). The boot check and the
 * deploy can generate independently — the app only needs these present, not identical across a
 * throwaway boot and the live container. A redeploy mints fresh values (existing JWT sessions end),
 * which is acceptable for delivery; a production store would pin them (env-manifest follow-up).
 */
export const generateAppSecrets = (): Record<string, string> => {
	const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
	const jwk = privateKey.export({ format: 'jwk' })
	const b = (part: string) => Buffer.from(part, 'base64url')
	const vapidPublicKey = Buffer.concat([Buffer.from([4]), b(jwk.x ?? ''), b(jwk.y ?? '')]).toString(
		'base64url'
	)
	return {
		AUTH_JWT_SECRET: randomBytes(48).toString('base64url'),
		VAPID_PUBLIC_KEY: vapidPublicKey,
		VAPID_PRIVATE_KEY: jwk.d ?? '',
		VAPID_SUBJECT: 'mailto:delivery@mjukvaruhuset.se',
	}
}

/** The same secrets as an ECS container `environment` list. */
export const appSecretsEnv = (): { name: string; value: string }[] =>
	Object.entries(generateAppSecrets()).map(([name, value]) => ({ name, value }))
