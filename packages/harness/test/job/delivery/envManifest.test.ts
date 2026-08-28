import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	buildEnvManifest,
	detectRequiredEnv,
	isPlaceholderValue,
	isSelfIssuedSecret,
	parseRequiredEnv,
	placeholderValue,
} from '#job/delivery/envManifest.ts'

import type { PreviewAuth } from '#job/delivery/types.ts'

// MARK: Fixtures

const previewAuth: PreviewAuth = {
	issuer: 'https://api.mjukvaruhuset.se',
	jwksUrl: 'https://api.mjukvaruhuset.se/.well-known/jwks.json',
	audience: 'preview',
}

/** Writes a secrets plugin whose `required` array declares `names` — the family-hub shape */
const writeSecretsPlugin = async (repoDir: string, app: string, names: string[]) => {
	await mkdir(join(repoDir, 'apps', app, 'src', 'plugins'), { recursive: true })
	await writeFile(
		join(repoDir, 'apps', app, 'src', 'plugins', 'secrets.ts'),
		`const required = [${names.map(name => `'${name}'`).join(', ')}] as const\nexport default required\n`
	)
}

// MARK: parseRequiredEnv

describe('parseRequiredEnv', () => {
	it('Parses the template one-element array', () => {
		expect(parseRequiredEnv(`const required = ['AUTH_AUDIENCE'] as const`)).toEqual(['AUTH_AUDIENCE'])
	})

	it('Parses a multi-line array with a type annotation and dedupes', () => {
		const source = `
			const required: readonly string[] = [
				"AUTH_AUDIENCE",
				'AUTH_JWT_SECRET',
				'VAPID_PUBLIC_KEY',
				'AUTH_AUDIENCE',
			] as const
		`
		expect(parseRequiredEnv(source)).toEqual(['AUTH_AUDIENCE', 'AUTH_JWT_SECRET', 'VAPID_PUBLIC_KEY'])
	})

	it('Returns [] when there is no required array', () => {
		expect(parseRequiredEnv('export const plugin = async () => {}')).toEqual([])
	})
})

// MARK: detectRequiredEnv

describe('detectRequiredEnv', () => {
	let repoDir: string
	beforeEach(async () => {
		repoDir = await mkdtemp(join(tmpdir(), 'mf-envmanifest-'))
	})
	afterEach(() => rm(repoDir, { recursive: true, force: true }))

	it('Reads the required array from an app secrets plugin', async () => {
		await writeSecretsPlugin(repoDir, 'api', ['AUTH_AUDIENCE', 'MAPBOX_TOKEN'])
		expect((await detectRequiredEnv(repoDir)).sort()).toEqual(['AUTH_AUDIENCE', 'MAPBOX_TOKEN'])
	})

	it('Unions the required env across multiple apps', async () => {
		await writeSecretsPlugin(repoDir, 'api', ['AUTH_AUDIENCE'])
		await writeSecretsPlugin(repoDir, 'worker', ['QUEUE_SIGNING_SECRET'])
		expect((await detectRequiredEnv(repoDir)).sort()).toEqual(['AUTH_AUDIENCE', 'QUEUE_SIGNING_SECRET'])
	})

	it('Returns [] for a static repo with no plugins', async () => {
		expect(await detectRequiredEnv(repoDir)).toEqual([])
	})
})

// MARK: isSelfIssuedSecret

describe('isSelfIssuedSecret', () => {
	it('A self-issued signing secret is generatable', () => {
		expect(isSelfIssuedSecret('SESSION_SECRET')).toBe(true)
		expect(isSelfIssuedSecret('APP_SIGNING_SECRET')).toBe(true)
		expect(isSelfIssuedSecret('SECRET_KEY')).toBe(true)
	})

	it("An external provider's secret is NOT (a random value would boot but silently fail live)", () => {
		expect(isSelfIssuedSecret('STRIPE_WEBHOOK_SECRET')).toBe(false)
		expect(isSelfIssuedSecret('GITHUB_OAUTH_CLIENT_SECRET')).toBe(false)
	})

	it('A non-secret var is not generatable this way', () => {
		expect(isSelfIssuedSecret('DATABASE_URL')).toBe(false)
	})
})

// MARK: buildEnvManifest

describe('buildEnvManifest', () => {
	let repoDir: string
	beforeEach(async () => {
		repoDir = await mkdtemp(join(tmpdir(), 'mf-envmanifest-'))
	})
	afterEach(() => rm(repoDir, { recursive: true, force: true }))

	it('Injects app secrets + auth contract even for a static repo (no required plugin)', async () => {
		const manifest = await buildEnvManifest(repoDir, previewAuth)
		expect(manifest.required).toEqual([])
		expect(manifest.env).toMatchObject({
			AUTH_ISSUER: previewAuth.issuer,
			AUTH_JWKS_URL: previewAuth.jwksUrl,
			AUTH_AUDIENCE: previewAuth.audience,
		})
		// generated app secrets are always on (the app uses them at runtime beyond the boot check)
		expect(Object.keys(manifest.env)).toEqual(
			expect.arrayContaining(['AUTH_JWT_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'])
		)
		expect(manifest.placeholders).toEqual([])
		expect(manifest.todos).toEqual([])
	})

	it('Generates a real value for a self-issued secret, and a flagged placeholder + TODO for an external one', async () => {
		await writeSecretsPlugin(repoDir, 'api', [
			'AUTH_AUDIENCE', // covered by the auth contract
			'AUTH_JWT_SECRET', // covered by the app secrets
			'APP_SIGNING_SECRET', // self-issued → generated
			'STRIPE_SECRET_KEY', // external → placeholder + TODO
		])

		const manifest = await buildEnvManifest(repoDir, previewAuth)

		// the required set is complete — every declared var has a value
		for (const name of manifest.required) expect(manifest.env[name]).toBeTruthy()
		// self-issued secret: a real generated value, NOT a placeholder
		expect(manifest.env.APP_SIGNING_SECRET).toBeTruthy()
		expect(isPlaceholderValue(manifest.env.APP_SIGNING_SECRET!)).toBe(false)
		// external secret: a flagged placeholder + a surfaced TODO
		expect(manifest.env.STRIPE_SECRET_KEY).toBe(placeholderValue('STRIPE_SECRET_KEY'))
		expect(isPlaceholderValue(manifest.env.STRIPE_SECRET_KEY!)).toBe(true)
		expect(manifest.placeholders).toEqual(['STRIPE_SECRET_KEY'])
		expect(manifest.todos).toHaveLength(1)
		expect(manifest.todos[0]).toContain('STRIPE_SECRET_KEY')
	})

	it('AUTH_AUDIENCE required but no previewAuth → placeholder, not a silent omission', async () => {
		await writeSecretsPlugin(repoDir, 'api', ['AUTH_AUDIENCE'])
		const manifest = await buildEnvManifest(repoDir, undefined)
		expect(manifest.env.AUTH_AUDIENCE).toBe(placeholderValue('AUTH_AUDIENCE'))
		expect(manifest.placeholders).toEqual(['AUTH_AUDIENCE'])
	})
})
