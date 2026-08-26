import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { acceptanceReportOf } from './types.ts'

import { criteriaOf } from '#job/gateSessions.ts'

import type { AcceptanceReport, GateReport, Plan, ReviewFinding, Spec } from '@mf/models'
import type { DeliveryTarget } from './types.ts'

// MARK: Tables (deterministic — generated from the gate reports, never by a model)

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()

export const renderGateTable = (gates: GateReport[]) => {
	if (!gates.length) return '_No gate ran._'
	const rows = gates.map(
		gate =>
			`| ${gate.name} | ${gate.ok ? 'OK' : 'FAILED'} | ${Math.round(gate.durationMs / 1000)} s | ${gate.tokens} | ${cell(gate.summary)} |`
	)
	return ['| Gate | Result | Duration | Tokens | Summary |', '|---|---|---|---|---|', ...rows].join(
		'\n'
	)
}

export const renderAcceptanceTable = (spec: Spec, report: AcceptanceReport | undefined) => {
	const criteria = criteriaOf(spec)
	if (!criteria.length) return '_The spec has no acceptance criteria._'
	const rows = criteria.map(criterion => {
		const entry = report?.[criterion.id]
		return `| ${criterion.id} | ${cell(criterion.feature)} | ${cell(criterion.text)} | ${entry?.status ?? 'unknown'} | ${cell(entry?.evidence.join('; ') ?? '-')} |`
	})
	return [
		'| Id | Feature | Criterion | Status | Evidence |',
		'|---|---|---|---|---|',
		...rows,
	].join('\n')
}

/** Low-severity review findings are recorded, never fixed (gates.ts) — they become known limitations */
export const lowFindingsOf = (gates: GateReport[]): ReviewFinding[] => {
	const review = gates.find(gate => gate.name === 'review')?.details
	const findings = (review?.findingsAfterFix ?? review?.findings ?? []) as ReviewFinding[]
	return findings.filter(finding => finding.severity === 'low')
}

export const renderKnownLimitations = (gates: GateReport[]) => {
	const findings = lowFindingsOf(gates)
	if (!findings.length) return '_The review gate left no open low-severity findings._'
	return findings
		.map(finding => `- \`${finding.file}:${finding.line}\` — ${cell(finding.claim)}`)
		.join('\n')
}

const renderFeatures = (spec: Spec) =>
	spec.features
		.map(feature => `- **${cell(feature.title)}** — ${cell(feature.description)}`)
		.join('\n') || '-'

const renderPlan = (plan: Plan | undefined) =>
	plan?.tasks.map(task => `- ${task.id}: ${cell(task.title)}`).join('\n') ?? '_No plan recorded._'

// MARK: Documents

export type DocsInput = {
	spec: Spec
	plan?: Plan
	gates: GateReport[]
	target: DeliveryTarget
	jobId: string
	/** Model-written overview paragraph(s); the deterministic fallback is the spec goal */
	summary?: string
	/** Tail of the verify gate's lint/test output */
	verifyOutput?: string
	/** Repository URL once known (docs are written before the push; README links are filled from the target) */
	repositoryUrl?: string
}

export const renderHandover = ({
	spec,
	plan,
	gates,
	target,
	jobId,
	summary,
	repositoryUrl,
}: DocsInput) => `# ${target.appName} — handover

Built by Mjukvaruhuset from the frozen spec (job \`${jobId}\`).

## What was built

${summary?.trim() || spec.goal}

### Features

${renderFeatures(spec)}

### Users

${spec.users.map(user => `- ${cell(user)}`).join('\n') || '-'}

### Out of scope (non-goals)

${spec.nonGoals.map(item => `- ${cell(item)}`).join('\n') || '-'}

## How to run

\`\`\`sh
npm i
npm run start:dev      # app on :5173, api on :5174 (see apps/api/.env.example)
npm run lint && npm test
npm run build
\`\`\`

## How to deploy

- \`infra/\` is a CDK app (S3 + CloudFront for the SPA, ECS Fargate for the api): \`npm i --prefix infra && cd infra && npx cdk deploy --all\`.
- \`apprunner.yaml\` in the repository root deploys the api container to AWS App Runner from source (this is how the preview URL in the portal was created).
- CI: \`.github/workflows/ci.yml\` runs lint, tests, build and synth on every push.

## Acceptance tests

One test file per acceptance criterion, \`<criterion id>.test.ts\`, under \`apps/*/acceptance/\`. Run them with \`npm test\`. The mapping from criterion to evidence is in \`TEST-REPORT.md\`.

## Build plan

${renderPlan(plan)}

## Gate summary

${renderGateTable(gates)}

## Known limitations

${renderKnownLimitations(gates)}

## Repository

${repositoryUrl ?? `https://github.com/mjukvaruhuset/${target.slug}`}
`

export const renderTestReport = ({ spec, gates, jobId, verifyOutput }: DocsInput) => {
	const verify = gates.find(gate => gate.name === 'verify')
	return `# Test report — job \`${jobId}\`

## Gates

${renderGateTable(gates)}

## Acceptance criteria

${renderAcceptanceTable(spec, acceptanceReportOf(gates))}

## Lint + test output (tail)

\`\`\`
${(verifyOutput ?? verify?.summary ?? '-').trim()}
\`\`\`
`
}

/**
 * The template README is about the template; the customer's README opens with their app and
 * keeps the template's sections (commands, layout) below.
 */
export const renderReadme = (existing: string, { spec, target, repositoryUrl }: DocsInput) => {
	const body = existing.replace(/^# .*\n+/, '')
	return `# ${target.appName}

${spec.goal}

Repository: ${repositoryUrl ?? `https://github.com/mjukvaruhuset/${target.slug}`} · Handover: [HANDOVER.md](HANDOVER.md) · Tests: [TEST-REPORT.md](TEST-REPORT.md)

---

${body}`
}

/**
 * App Runner source-code deployment of the api. App Runner's managed Node runtime lags the
 * template's Node 24 requirement, so the api is started with type stripping on Node 22 — a v1
 * limitation documented in HANDOVER.md; the customer's own CDK (`infra/`) is the real deploy.
 */
export const renderAppRunnerConfig = () => `version: 1.0
runtime: nodejs22
build:
  commands:
    build:
      - npm ci --ignore-scripts --no-audit --no-fund
run:
  runtime-version: 22
  command: node --experimental-strip-types apps/api/src/index.ts
  network:
    port: 80
  env:
    - name: PORT
      value: "80"
    - name: ADDRESS
      value: "0.0.0.0"
    - name: ENV
      value: preview
    - name: AUTH_AUDIENCE
      value: preview
`

/** Writes HANDOVER.md, TEST-REPORT.md, README.md and apprunner.yaml into the repo */
export const writeDocs = async (repoDir: string, input: DocsInput) => {
	const readme = await readFile(join(repoDir, 'README.md'), 'utf8').catch(() => '')
	const files = {
		'HANDOVER.md': renderHandover(input),
		'TEST-REPORT.md': renderTestReport(input),
		'README.md': renderReadme(readme, input),
		'apprunner.yaml': renderAppRunnerConfig(),
	}
	for (const [name, content] of Object.entries(files)) {
		await writeFile(join(repoDir, name), content)
	}
	return files
}
