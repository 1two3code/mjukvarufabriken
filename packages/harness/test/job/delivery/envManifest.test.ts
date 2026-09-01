import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	buildEnvManifest,
	detectDatabaseNeed,
	detectRequiredEnv,
	detectStorageNeed,
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
		expect(parseRequiredEnv(`const required = ['AUTH_AUDIENCE'] as const`)).toEqual([
			'AUTH_AUDIENCE',
		])
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
		expect(parseRequiredEnv(source)).toEqual([
			'AUTH_AUDIENCE',
			'AUTH_JWT_SECRET',
			'VAPID_PUBLIC_KEY',
		])
	})

	it('Returns [] when there is no required array', () => {
		expect(parseRequiredEnv('export const plugin = async () => {}')).toEqual([])
	})

	it('Does not truncate on a `]` inside an inline comment', () => {
		const source = `
			const required = [
				'AUTH_AUDIENCE', // first of many[0], keep going
				'SESSION_SECRET',
				/* block ] comment */ 'CSRF_SECRET',
			] as const
		`
		expect(parseRequiredEnv(source)).toEqual(['AUTH_AUDIENCE', 'SESSION_SECRET', 'CSRF_SECRET'])
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
		expect((await detectRequiredEnv(repoDir)).sort()).toEqual([
			'AUTH_AUDIENCE',
			'QUEUE_SIGNING_SECRET',
		])
	})

	it('Returns [] for a static repo with no plugins', async () => {
		expect(await detectRequiredEnv(repoDir)).toEqual([])
	})

	it('Detects env in a non-apps/ layout (root-level src, as serverEntryOf now boots)', async () => {
		await mkdir(join(repoDir, 'src', 'plugins'), { recursive: true })
		await writeFile(
			join(repoDir, 'src', 'plugins', 'secrets.ts'),
			`const required = ['AUTH_AUDIENCE', 'SESSION_SECRET'] as const\nexport default required\n`
		)
		expect((await detectRequiredEnv(repoDir)).sort()).toEqual(['AUTH_AUDIENCE', 'SESSION_SECRET'])
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

	it('An UNKNOWN secret-shaped var is NOT minted (inverted default → placeholder, never silent random)', () => {
		// Not on any external-provider list, but also not a known self-issued name → not minted.
		expect(isSelfIssuedSecret('PLAID_CLIENT_SECRET')).toBe(false)
		expect(isSelfIssuedSecret('ACME_API_SECRET')).toBe(false)
		expect(isSelfIssuedSecret('WEBHOOK_SECRET_KEY')).toBe(false)
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
			expect.arrayContaining([
				'AUTH_JWT_SECRET',
				'VAPID_PUBLIC_KEY',
				'VAPID_PRIVATE_KEY',
				'VAPID_SUBJECT',
			])
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

	it('An unknown provider secret (PLAID_CLIENT_SECRET) → flagged placeholder + TODO, never a silent random', async () => {
		await writeSecretsPlugin(repoDir, 'api', ['PLAID_CLIENT_SECRET'])
		const manifest = await buildEnvManifest(repoDir, previewAuth)
		expect(manifest.env.PLAID_CLIENT_SECRET).toBe(placeholderValue('PLAID_CLIENT_SECRET'))
		expect(isPlaceholderValue(manifest.env.PLAID_CLIENT_SECRET!)).toBe(true)
		expect(manifest.placeholders).toEqual(['PLAID_CLIENT_SECRET'])
		expect(manifest.todos).toHaveLength(1)
		expect(manifest.todos[0]).toContain('PLAID_CLIENT_SECRET')
	})

	it('AUTH_AUDIENCE required but no previewAuth → placeholder, not a silent omission', async () => {
		await writeSecretsPlugin(repoDir, 'api', ['AUTH_AUDIENCE'])
		const manifest = await buildEnvManifest(repoDir, undefined)
		expect(manifest.env.AUTH_AUDIENCE).toBe(placeholderValue('AUTH_AUDIENCE'))
		expect(manifest.placeholders).toEqual(['AUTH_AUDIENCE'])
	})
})

describe('detectDatabaseNeed', () => {
	let repoDir: string
	beforeEach(async () => {
		repoDir = await mkdtemp(join(tmpdir(), 'mf-dbneed-'))
	})
	afterEach(() => rm(repoDir, { recursive: true, force: true }))

	it('a repo with no DB signal needs nothing', async () => {
		expect(await detectDatabaseNeed(repoDir, ['AUTH_AUDIENCE'])).toEqual({
			needed: false,
			evidence: [],
		})
	})

	it('DATABASE_URL in the declared required env is a need', async () => {
		const need = await detectDatabaseNeed(repoDir, ['DATABASE_URL'])
		expect(need.needed).toBe(true)
		expect(need.evidence[0]).toContain('DATABASE_URL')
	})

	it('a known DB client in package.json dependencies is a need', async () => {
		await mkdir(join(repoDir, 'apps', 'api'), { recursive: true })
		await writeFile(
			join(repoDir, 'apps', 'api', 'package.json'),
			JSON.stringify({ dependencies: { pg: '^8.0.0', fastify: '^5' } })
		)
		const need = await detectDatabaseNeed(repoDir, [])
		expect(need.needed).toBe(true)
		expect(need.evidence[0]).toContain('pg')
	})

	it('a migrations/ directory is a need', async () => {
		await mkdir(join(repoDir, 'migrations'), { recursive: true })
		const need = await detectDatabaseNeed(repoDir, [])
		expect(need.needed).toBe(true)
		expect(need.evidence[0]).toContain('migrations/')
	})
})

describe('detectStorageNeed', () => {
	let repoDir: string
	beforeEach(async () => {
		repoDir = await mkdtemp(join(tmpdir(), 'mf-storeneed-'))
	})
	afterEach(() => rm(repoDir, { recursive: true, force: true }))

	it('a repo with no storage signal needs nothing', async () => {
		expect(await detectStorageNeed(repoDir, ['DATABASE_URL'])).toEqual({
			needed: false,
			evidence: [],
		})
	})

	it('a declared bucket env var is a need', async () => {
		const need = await detectStorageNeed(repoDir, ['S3_BUCKET'])
		expect(need.needed).toBe(true)
		expect(need.evidence[0]).toContain('S3_BUCKET')
	})

	it('an S3 client dependency is a need', async () => {
		await mkdir(join(repoDir, 'apps', 'api'), { recursive: true })
		await writeFile(
			join(repoDir, 'apps', 'api', 'package.json'),
			JSON.stringify({ dependencies: { '@aws-sdk/client-s3': '^3', fastify: '^5' } })
		)
		const need = await detectStorageNeed(repoDir, [])
		expect(need.needed).toBe(true)
		expect(need.evidence[0]).toContain('@aws-sdk/client-s3')
	})

	// The photo-PWA shape: an app that accepts uploads has to put them somewhere, and on a preview
	// the container's disk dies with the next deployment — so an upload middleware alone is a need.
	it('an upload middleware alone is a need', async () => {
		await mkdir(join(repoDir, 'apps', 'api'), { recursive: true })
		await writeFile(
			join(repoDir, 'apps', 'api', 'package.json'),
			JSON.stringify({ dependencies: { '@fastify/multipart': '^9' } })
		)
		const need = await detectStorageNeed(repoDir, [])
		expect(need.needed).toBe(true)
		expect(need.evidence[0]).toContain('@fastify/multipart')
	})
})
