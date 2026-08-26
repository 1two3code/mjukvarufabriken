/**
 * Inserts a queued demo job with a tiny frozen spec so the orchestrator can be exercised
 * locally without the api: `npm run db:seed` prints the job id, then
 * `npm run job:dev -- <id>` runs it. Budget/workers are overridable via env
 * (`SEED_MAX_TOKENS`, `SEED_MAX_WORKERS`, `SEED_ORG_ID`).
 */
import { createDb, insertJob } from '#/index.ts'

import type { Spec } from '@mf/models'

const url = process.env.DATABASE_URL
if (!url) {
	console.error('DATABASE_URL is not set (see packages/db/README.md)')
	process.exit(1)
}

export const demoSpec: Spec = {
	goal: 'A one-page Swedish/English marketing site for a small carpentry business with a contact form. No backend: the form posts to a mailto link.',
	users: ['visitors looking for a carpenter', 'the owner (updates texts in code)'],
	features: [
		{
			title: 'Landing page',
			description:
				'One page with hero, three service cards (kitchens, stairs, custom furniture) and a footer with address and phone. Responsive.',
			acceptanceCriteria: [
				'The page renders a hero heading, three service cards and a footer on desktop and mobile widths',
			],
		},
		{
			title: 'Language toggle sv/en',
			description: 'A toggle switches every visible text between Swedish and English.',
			acceptanceCriteria: [
				'Clicking the language toggle switches all page texts between Swedish and English',
			],
		},
		{
			title: 'Contact form',
			description:
				'Name, email and message fields with validation. Submit opens a mailto link with the message prefilled; no server.',
			acceptanceCriteria: [
				'Submitting with an empty name or an invalid email shows a validation message and does not open the mail client',
				'Submitting a valid form opens a mailto link containing the message',
			],
		},
	],
	nonGoals: ['No backend, no database, no CMS, no payments'],
	stackConstraints: [],
	sizeClass: 'S',
}

const db = createDb(url, { max: 1 })
try {
	const job = await insertJob(db, {
		orderId: 'demo',
		orgId: process.env.SEED_ORG_ID ?? 'demo-org',
		spec: demoSpec,
		budget: {
			maxTokens: Number(process.env.SEED_MAX_TOKENS ?? 400_000),
			maxWorkers: Number(process.env.SEED_MAX_WORKERS ?? 2),
			maxDurationMinutes: 60,
		},
	})
	console.log(job.id)
} finally {
	await db.close()
}
