import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GateReportSchema, LicenceGateDetailsSchema } from '@mf/models'

import {
	collectLicences,
	isDeniedLicence,
	licenceDenialOf,
	licenceFileName,
	licenceGate,
	licenceWaiverId,
	parseNpmLs,
	renderLicenceFile,
	repositoryUrlOf,
} from '#job/gates/licence.ts'

import type { LicenceGateDetails, Spec } from '@mf/models'
import type { GateInput } from '#job/types.ts'

// MARK: Fixtures

const spec: Spec = {
	goal: 'x',
	users: [],
	features: [{ title: 'f', description: '', acceptanceCriteria: ['a'] }],
	nonGoals: [],
	stackConstraints: [],
}

type FakePackage = {
	name: string
	version: string
	/** Omitted → no package.json written at all */
	manifest?: Record<string, unknown>
	dependencies?: FakePackage[]
	/** Where npm would have installed it (default: nested under its parent) */
	path?: string
	private?: boolean
}

/** Writes `node_modules/<pkg>/package.json` files and returns the `npm ls --long` JSON for them */
const installFixture = async (root: string, packages: FakePackage[]) => {
	const node = async (pkg: FakePackage, parentPath: string): Promise<Record<string, unknown>> => {
		const path = pkg.path ?? join(parentPath, 'node_modules', pkg.name)
		if (pkg.manifest) {
			await mkdir(path, { recursive: true })
			await writeFile(
				join(path, 'package.json'),
				JSON.stringify({ name: pkg.name, version: pkg.version, ...pkg.manifest })
			)
		}
		const dependencies: Record<string, unknown> = {}
		for (const child of pkg.dependencies ?? []) dependencies[child.name] = await node(child, path)
		return { name: pkg.name, version: pkg.version, path, private: pkg.private, dependencies }
	}
	const dependencies: Record<string, unknown> = {}
	for (const pkg of packages) dependencies[pkg.name] = await node(pkg, root)
	return JSON.stringify({
		name: 'customer-app',
		version: '1.0.0',
		private: true,
		path: root,
		dependencies,
	})
}

const mit = (
	name: string,
	version = '1.0.0',
	extra: Record<string, unknown> = {}
): FakePackage => ({
	name,
	version,
	manifest: {
		license: 'MIT',
		repository: { type: 'git', url: `git+https://github.com/x/${name}.git` },
		...extra,
	},
})

const runGate = async (root: string, tree: string, waivers: string[] = []) => {
	const input: GateInput = {
		spec,
		repoDir: root,
		waivers,
		signal: new AbortController().signal,
		onUsage: () => {},
	}
	const outcome = await licenceGate(input, {
		npmLs: async () => tree,
		now: () => new Date('2026-08-27T12:00:00Z'),
	})
	const details = LicenceGateDetailsSchema.parse(outcome.details)
	const file = await readFile(join(root, licenceFileName), 'utf8')
	return { outcome, details, file }
}

// MARK: Tests

describe('isDeniedLicence', () => {
	it.each([
		['MIT', false],
		['Apache-2.0', false],
		['BSD-3-Clause', false],
		['0BSD', false],
		['LGPL-2.1-only', false],
		['LGPL-3.0-or-later', false],
		['GPL-2.0-with-classpath-exception', false],
		['GPL-2.0-only WITH Classpath-exception-2.0', false],
		['Apache-2.0 WITH LLVM-exception', false],
		['LicenseRef-scancode-x', false],
		// Every GPL family spelling: current, deprecated, plus, free text
		['GPL-2.0-only', true],
		['GPL-3.0-only', true],
		['gpl-3.0-only', true],
		['GPL-2.0', true],
		['GPL-3.0', true],
		['GPL-2.0+', true],
		['GPL-3.0+', true],
		['GPL-2.0-or-later', true],
		['GPL-3.0-or-later', true],
		['GPLv2', true],
		['GPLv3', true],
		['GPL', true],
		['GPL-1.0', true],
		['AGPL', true],
		['AGPL-3.0', true],
		['AGPL-3.0-only', true],
		['AGPL-3.0-or-later', true],
		['SSPL', true],
		['SSPL-1.0', true],
		['UNLICENSED', true],
		['UNKNOWN', true],
		['', true],
		['   ', true],
		// Free text the gate cannot judge needs a waiver
		['SEE LICENSE IN LICENSE.txt', true],
		['Proprietary', true],
		['Commercial', true],
		['Custom', true],
		['Public Domain', true],
		['https://example.com/licence', true],
		['Apache License 2.0', true],
		// Expressions
		['(MIT OR GPL-3.0-only)', false],
		['MIT OR GPL-3.0', false],
		['mit or gpl-3.0', false],
		['(GPL-2.0-only OR AGPL-3.0-only)', true],
		['(MIT AND GPL-3.0-only)', true],
		['MIT and GPL-3.0-only', true],
		['(MIT AND Apache-2.0)', false],
		['GPL-3.0-only AND (MIT OR ISC)', true],
		['(GPL-3.0-only AND MIT) OR ISC', false],
		['MIT OR (GPL-3.0-only AND ISC)', false],
		['(GPL-2.0-only OR GPL-3.0-only) AND MIT', true],
		['((MIT))', false],
		['MIT OR (SEE LICENSE IN x)', false],
		// Malformed never passes
		['(MIT', true],
		['MIT)', true],
		['MIT OR', true],
		['OR MIT', true],
		['MIT WITH', true],
		['()', true],
	])('%s → denied %s', (expression, denied) => {
		expect(isDeniedLicence(expression)).toBe(denied)
	})

	it('Gives the reason for a denial', () => {
		expect(licenceDenialOf('GPL-3.0')).toBe('licence GPL-3.0 is on the denylist')
		expect(licenceDenialOf('MIT AND GPL-3.0')).toBe('licence GPL-3.0 is on the denylist')
		expect(licenceDenialOf('UNLICENSED')).toBe('no licence declared in package.json')
		expect(licenceDenialOf('SEE LICENSE IN LICENSE.txt')).toBe(
			'"SEE LICENSE IN LICENSE.txt" is not an SPDX licence identifier — needs an admin waiver'
		)
		expect(licenceDenialOf('(MIT')).toBe('malformed licence expression')
		expect(licenceDenialOf('MIT')).toBeUndefined()
	})
})

describe('parseNpmLs', () => {
	it('Refuses an npm error payload and an empty tree instead of passing them as clean', () => {
		expect(() =>
			parseNpmLs(JSON.stringify({ error: { code: 'EJSONPARSE', summary: 'bad package.json' } }))
		).toThrow('npm ls failed (EJSONPARSE): bad package.json')
		expect(() => parseNpmLs(JSON.stringify({ name: 'x', version: '1.0.0' }))).toThrow(
			'npm ls listed no dependencies'
		)
		expect(() => parseNpmLs(JSON.stringify({ name: 'x', dependencies: {} }))).toThrow(
			'npm ls listed no dependencies'
		)
	})

	it('Proceeds when npm reports ELSPROBLEMS but still ships the dependency tree', () => {
		const tree = parseNpmLs(
			JSON.stringify({
				error: { code: 'ELSPROBLEMS', summary: 'invalid: ajv@6.15.0' },
				dependencies: { ajv: { version: '6.15.0' } },
			})
		)
		expect(Object.keys(tree.dependencies ?? {})).toEqual(['ajv'])
		expect(() => parseNpmLs('not json')).toThrow()
	})

	it('Accepts a tree with dependencies', () => {
		expect(parseNpmLs(JSON.stringify({ dependencies: { a: { version: '1.0.0' } } }))).toEqual({
			dependencies: { a: { version: '1.0.0' } },
		})
	})
})

describe('repositoryUrlOf', () => {
	it.each([
		[{ repository: { url: 'git+https://github.com/x/y.git' } }, 'https://github.com/x/y'],
		[{ repository: 'git+ssh://git@github.com/x/y.git' }, 'https://github.com/x/y'],
		[{ repository: 'git@github.com:x/y.git' }, 'https://github.com/x/y'],
		[{ repository: 'x/y' }, 'https://github.com/x/y'],
		[{ repository: 'gitlab:x/y' }, 'https://gitlab.com/x/y'],
		[{ repository: 'http://example.com/repo' }, 'https://example.com/repo'],
		[{}, undefined],
		[{ repository: { url: ' ' } }, undefined],
	])('%j → %s', (pkg, url) => {
		expect(repositoryUrlOf(pkg)).toBe(url)
	})
})

describe('licenceGate', () => {
	let root: string

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mf-licence-'))
	})
	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	it('Passes a clean tree, counts by licence and writes THIRD-PARTY-LICENCES.md', async () => {
		const tree = await installFixture(root, [
			{ ...mit('a'), dependencies: [{ ...mit('b', '2.0.0', { license: 'ISC' }) }] },
			mit('@scope/c', '3.1.0', { license: { type: 'Apache-2.0' } }),
		])

		const { outcome, details, file } = await runGate(root, tree)

		expect(outcome.ok).toBe(true)
		expect(outcome.tokens).toBe(0)
		expect(outcome.summary).toBe(
			'3 package(s), 3 licence(s), none denied; THIRD-PARTY-LICENCES.md written'
		)
		expect(details).toEqual<LicenceGateDetails>({
			packages: 3,
			byLicence: { 'Apache-2.0': 1, ISC: 1, MIT: 1 },
			violations: [],
			waived: [],
			missing: [],
			file: licenceFileName,
		})
		expect(file).toContain('Generated 2026-08-27')
		expect(file).toContain('| MIT | 1 |')
		expect(file).toContain('| @scope/c | 3.1.0 | Apache-2.0 | https://github.com/x/@scope/c |')
		expect(file).toContain('| b | 2.0.0 | ISC | https://github.com/x/b |')
		// Sorted by name: @scope/c, a, b
		expect(file.indexOf('| @scope/c |')).toBeLessThan(file.indexOf('| a |'))
		expect(
			GateReportSchema.parse({
				name: 'licence',
				ok: true,
				startedAt: new Date().toISOString(),
				durationMs: 1,
				tokens: 0,
				summary: outcome.summary,
				details: outcome.details,
			})
		).toBeTruthy()
	})

	it('Fails on a denylisted licence and on a package with no licence, naming the offenders', async () => {
		const tree = await installFixture(root, [
			mit('a'),
			{ name: 'gpl', version: '1.2.3', manifest: { licenses: [{ type: 'GPL-3.0-only' }] } },
			{ name: 'bare', version: '0.0.1', manifest: {} },
		])

		const { outcome, details, file } = await runGate(root, tree)

		expect(outcome.ok).toBe(false)
		expect(outcome.summary).toBe(
			'2 package(s) with a denied licence: bare@0.0.1 (UNKNOWN), gpl@1.2.3 (GPL-3.0-only) — 3 package(s), 3 licence(s)'
		)
		expect(details.violations).toEqual([
			{
				name: 'bare',
				version: '0.0.1',
				licence: 'UNKNOWN',
				repository: undefined,
				waiverId: 'licence:bare@0.0.1',
				reason: 'no licence declared in package.json',
			},
			{
				name: 'gpl',
				version: '1.2.3',
				licence: 'GPL-3.0-only',
				repository: undefined,
				waiverId: 'licence:gpl@1.2.3',
				reason: 'licence GPL-3.0-only is on the denylist',
			},
		])
		expect(details.byLicence).toEqual({ 'GPL-3.0-only': 1, MIT: 1, UNKNOWN: 1 })
		// The list is written even when the gate is red
		expect(file).toContain('| gpl | 1.2.3 | GPL-3.0-only | - |')
	})

	it('Accepts a denied package when licence:<pkg>@<version> is waived, and only that version', async () => {
		const tree = await installFixture(root, [
			{ name: 'gpl', version: '1.2.3', manifest: { license: 'AGPL-3.0-only' } },
			{
				name: 'a',
				version: '1.0.0',
				manifest: { license: 'MIT' },
				dependencies: [{ name: 'gpl', version: '2.0.0', manifest: { license: 'AGPL-3.0-only' } }],
			},
		])

		const waivedOne = await runGate(root, tree, [licenceWaiverId('gpl', '1.2.3')])
		expect(waivedOne.outcome.ok).toBe(false)
		expect(waivedOne.details.violations.map(v => v.waiverId)).toEqual(['licence:gpl@2.0.0'])
		expect(waivedOne.details.waived.map(v => v.waiverId)).toEqual(['licence:gpl@1.2.3'])
		expect(waivedOne.outcome.summary).toContain('1 waived')

		const waivedBoth = await runGate(root, tree, ['licence:gpl@1.2.3', 'licence:gpl@2.0.0'])
		expect(waivedBoth.outcome.ok).toBe(true)
		expect(waivedBoth.outcome.summary).toBe(
			'3 package(s), 2 licence(s), none denied; 2 waived; THIRD-PARTY-LICENCES.md written'
		)
	})

	it('Passes an OR expression with an acceptable alternative, fails an AND with a denied part', async () => {
		const tree = await installFixture(root, [
			{ name: 'dual', version: '1.0.0', manifest: { license: '(MIT OR GPL-3.0-only)' } },
			{ name: 'legacy', version: '1.0.0', manifest: { licenses: ['MIT', 'GPL-2.0-only'] } },
			{ name: 'both', version: '1.0.0', manifest: { license: '(MIT AND AGPL-3.0-only)' } },
		])

		const { outcome, details } = await runGate(root, tree)

		expect(outcome.ok).toBe(false)
		expect(details.violations.map(v => v.name)).toEqual(['both'])
		expect(details.byLicence).toEqual({
			'(MIT AND AGPL-3.0-only)': 1,
			'(MIT OR GPL-2.0-only)': 1,
			'(MIT OR GPL-3.0-only)': 1,
		})
	})

	it('Skips the root and workspace packages; dedupes name@version; reports missing nodes', async () => {
		const shared = mit('shared', '1.0.0')
		const tree = await installFixture(root, [
			{ ...mit('a'), dependencies: [shared] },
			{ ...mit('b'), dependencies: [{ ...shared, path: join(root, 'node_modules', 'shared') }] },
			{
				name: '@customer/models',
				version: '0.1.0',
				private: true,
				manifest: { private: true, license: 'UNLICENSED' },
				path: join(root, 'packages', 'models'),
			},
		])
		const withMissing = JSON.parse(tree) as { dependencies: Record<string, unknown> }
		withMissing.dependencies['ghost'] = { version: '9.9.9', missing: true }
		withMissing.dependencies['@os/darwin-bin'] = { missing: true }

		const { outcome, details, file } = await runGate(root, JSON.stringify(withMissing))

		expect(outcome.ok).toBe(true)
		expect(details.packages).toBe(3)
		expect(Object.keys(details.byLicence)).toEqual(['MIT'])
		expect(details.missing).toEqual(['@os/darwin-bin@?', 'ghost@9.9.9'])
		expect(outcome.summary).toContain('2 not installed here (@os/darwin-bin@?, ghost@9.9.9)')
		expect(file).toContain('## Not installed on the build platform')
		expect(file).toContain('`ghost@9.9.9`')
	})

	it('Checks a private-flagged package installed under node_modules (git/file dependency)', async () => {
		const tree = await installFixture(root, [
			mit('a'),
			{
				name: 'gpl-lib',
				version: '0.0.0',
				private: true,
				manifest: { private: true, license: 'AGPL-3.0-only' },
			},
		])

		const { outcome, details } = await runGate(root, tree)

		expect(outcome.ok).toBe(false)
		expect(details.violations.map(v => v.waiverId)).toEqual(['licence:gpl-lib@0.0.0'])
	})

	// A private, UNLICENSED third-party dep (a git/file dependency) lives under node_modules, not in
	// the repo's workspaces, so `private: true` must not exempt it: it is a real redistribution
	// concern and must be flagged, not silently dropped from both the report and the violation check.
	it('Flags a private + UNLICENSED package installed under node_modules', async () => {
		const tree = await installFixture(root, [
			mit('a'),
			{
				name: 'closed-lib',
				version: '2.3.4',
				private: true,
				manifest: { private: true, license: 'UNLICENSED' },
			},
		])

		const { outcome, details } = await runGate(root, tree)

		expect(outcome.ok).toBe(false)
		expect(details.violations.map(v => v.waiverId)).toEqual(['licence:closed-lib@2.3.4'])
	})

	it('Fails on deprecated GPL ids and free-text licences with a reason per package', async () => {
		const tree = await installFixture(root, [
			{ name: 'old', version: '1.0.0', manifest: { license: 'GPL-3.0' } },
			{ name: 'later', version: '1.0.0', manifest: { license: 'GPL-2.0-or-later' } },
			{ name: 'see', version: '1.0.0', manifest: { license: 'SEE LICENSE IN LICENSE.txt' } },
			{ name: 'lgpl', version: '1.0.0', manifest: { license: 'LGPL-3.0-or-later' } },
		])

		const { outcome, details } = await runGate(root, tree)

		expect(outcome.ok).toBe(false)
		expect(details.violations.map(v => [v.name, v.reason])).toEqual([
			['later', 'licence GPL-2.0-or-later is on the denylist'],
			['old', 'licence GPL-3.0 is on the denylist'],
			['see', '"SEE LICENSE IN LICENSE.txt" is not an SPDX licence identifier — needs an admin waiver'],
		])
	})

	it('Fails (throws, red) on an npm error payload instead of passing an empty list', async () => {
		await expect(
			runGate(root, JSON.stringify({ error: { code: 'ELOCKVERIFY', summary: 'lock mismatch' } }))
		).rejects.toThrow('npm ls failed (ELOCKVERIFY): lock mismatch')
	})

	it('Falls back to the parent path for a node without `path` (nested-only package)', async () => {
		const tree = await installFixture(root, [
			{ ...mit('a'), dependencies: [mit('nested', '1.0.0', { license: 'ISC' })] },
		])
		const stripped = JSON.parse(tree) as {
			dependencies: Record<string, { path?: string; dependencies: Record<string, { path?: string }> }>
		}
		delete stripped.dependencies['a']!.dependencies['nested']!.path

		const { outcome, details } = await runGate(root, JSON.stringify(stripped))

		expect(outcome.ok).toBe(true)
		expect(details.byLicence).toEqual({ ISC: 1, MIT: 1 })
	})

	it('Treats an unreadable package.json as UNKNOWN (red) and says so in the summary', async () => {
		const tree = await installFixture(root, [mit('a'), { name: 'broken', version: '1.0.0' }])

		const { outcome, details } = await runGate(root, tree)

		expect(outcome.ok).toBe(false)
		expect(details.violations.map(v => `${v.name}:${v.licence}`)).toEqual(['broken:UNKNOWN'])
		expect(outcome.summary).toContain('1 package.json unreadable (broken@1.0.0)')
	})

	it('Propagates an npm ls failure so runGates counts the gate as crashed (red)', async () => {
		await expect(
			licenceGate(
				{
					spec,
					repoDir: root,
					waivers: [],
					signal: new AbortController().signal,
					onUsage: () => {},
				},
				{
					npmLs: async () => {
						throw new Error('npm ls produced no output (1): ENOENT')
					},
				}
			)
		).rejects.toThrow('npm ls produced no output')
	})

	it('Runs the real npm ls against a small node_modules tree', async () => {
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ name: 'fx', version: '1.0.0', private: true, dependencies: { a: '1.0.0' } })
		)
		await installFixture(root, [
			{
				...mit('a'),
				dependencies: [{ name: 'b', version: '1.0.0', manifest: { license: 'GPL-2.0-only' } }],
			},
		])

		const outcome = await licenceGate({
			spec,
			repoDir: root,
			waivers: [],
			signal: new AbortController().signal,
			onUsage: () => {},
		})

		expect(outcome.ok).toBe(false)
		expect((outcome.details as LicenceGateDetails).violations.map(v => v.waiverId)).toEqual([
			'licence:b@1.0.0',
		])
		expect((outcome.details as LicenceGateDetails).byLicence).toEqual({ 'GPL-2.0-only': 1, MIT: 1 })
	}, 30_000)
})

describe('collectLicences / renderLicenceFile', () => {
	it('Renders an empty tree without breaking the tables', async () => {
		const { entries, unreadable, missing } = await collectLicences({ name: 'root' }, '/nowhere')
		expect(entries).toEqual([])
		expect(unreadable).toEqual([])
		expect(missing).toEqual([])
		const file = renderLicenceFile(entries, new Date('2026-01-01T00:00:00Z'))
		expect(file).toContain('| - | 0 |')
		expect(file).toContain('| - | - | - | - |')
	})

	it('Escapes pipes in licence text so the table stays intact', () => {
		const file = renderLicenceFile(
			[{ name: 'odd', version: '1.0.0', licence: 'SEE LICENSE | IN FILE' }],
			new Date('2026-01-01T00:00:00Z')
		)
		expect(file).toContain('| odd | 1.0.0 | SEE LICENSE \\| IN FILE | - |')
	})
})
