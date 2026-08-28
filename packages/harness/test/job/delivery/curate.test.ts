import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { curateWorkflows, customerCiWorkflow } from '#job/delivery/curate.ts'

const workflowsOf = (repoDir: string) => join(repoDir, '.github', 'workflows')

const seedTemplateWorkflows = async (repoDir: string) => {
	const dir = workflowsOf(repoDir)
	await mkdir(dir, { recursive: true })
	// The template ships these three (ci + our two OIDC deploy workflows)
	await writeFile(join(dir, 'ci.yml'), 'name: CI\njobs: { verify: { steps: [{ run: cdk synth }] } }\n')
	await writeFile(
		join(dir, 'deploy.yml'),
		'name: Deploy\npermissions: { id-token: write }\njobs: { dev: {} }\n'
	)
	await writeFile(join(dir, 'deploy-environment.yml'), 'name: Deploy env\njobs: {}\n')
}

describe('curateWorkflows', () => {
	let root: string
	let repoDir: string
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'mf-curate-'))
		repoDir = join(root, 'repo')
		await mkdir(repoDir, { recursive: true })
	})
	afterEach(() => rm(root, { recursive: true, force: true }))

	it('Strips our deploy workflows and leaves only a clean lint+test CI', async () => {
		// Arrange
		await seedTemplateWorkflows(repoDir)

		// Act
		const outcome = await curateWorkflows(repoDir)

		// Assert — deploy workflows removed, ci.yml the only file left
		expect(outcome.removed).toEqual(['ci.yml', 'deploy-environment.yml', 'deploy.yml'])
		expect(outcome.wrote).toBe('.github/workflows/ci.yml')
		expect(await readdir(workflowsOf(repoDir))).toEqual(['ci.yml'])

		const ci = await readFile(join(workflowsOf(repoDir), 'ci.yml'), 'utf8')
		expect(ci).toBe(customerCiWorkflow)
		// No deploy, no OIDC, no reference to our account / CDK
		expect(ci).not.toMatch(/deploy/i)
		expect(ci).not.toMatch(/id-token/)
		expect(ci).not.toMatch(/oidc/i)
		expect(ci).not.toMatch(/aws|cdk|role-to-assume/i)
		// Is a real lint+test CI
		expect(ci).toContain('npm run lint')
		expect(ci).toContain('npm test')
	})

	it('Removes .yaml workflows too, not just .yml', async () => {
		// Arrange
		const dir = workflowsOf(repoDir)
		await mkdir(dir, { recursive: true })
		await writeFile(join(dir, 'release.yaml'), 'name: Release\n')
		await writeFile(join(dir, 'notes.txt'), 'keep me? no — only ci.yml should remain')

		// Act
		const outcome = await curateWorkflows(repoDir)

		// Assert — the .yaml is stripped; only ci.yml remains among workflow files
		expect(outcome.removed).toEqual(['release.yaml'])
		const remaining = await readdir(dir)
		expect(remaining).toContain('ci.yml')
		expect(remaining).not.toContain('release.yaml')
	})

	it('Creates the workflows directory and writes ci.yml when the repo had none', async () => {
		// Act — no .github at all
		const outcome = await curateWorkflows(repoDir)

		// Assert
		expect(outcome.removed).toEqual([])
		expect(await readdir(workflowsOf(repoDir))).toEqual(['ci.yml'])
	})

	it('Is idempotent — a second run leaves exactly the clean CI', async () => {
		// Arrange
		await seedTemplateWorkflows(repoDir)

		// Act
		await curateWorkflows(repoDir)
		const outcome = await curateWorkflows(repoDir)

		// Assert — second run only re-strips the ci.yml it wrote, still one clean file
		expect(outcome.removed).toEqual(['ci.yml'])
		expect(await readdir(workflowsOf(repoDir))).toEqual(['ci.yml'])
		expect(await readFile(join(workflowsOf(repoDir), 'ci.yml'), 'utf8')).toBe(customerCiWorkflow)
	})
})
