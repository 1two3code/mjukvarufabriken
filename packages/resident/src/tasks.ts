import { randomUUID } from 'node:crypto'

import type { NewResidentTask, ResidentTask, Spec } from '@mf/models'
import type { ResidentIssue } from '#/github.ts'

/** GitHub label that queues an issue for the resident, and the ones it sets itself */
export const residentLabels = {
	queue: 'resident',
	running: 'resident:running',
	done: 'resident:done',
	failed: 'resident:failed',
} as const

/** Task ids are short and branch-safe: `resident/<id>` */
export const newTaskId = () => randomUUID().slice(0, 8)

export const branchOf = (task: Pick<ResidentTask, 'id'>) => `resident/${task.id}`

export const taskFromInput = (
	input: NewResidentTask,
	now: () => number = Date.now
): ResidentTask => ({
	id: newTaskId(),
	source: 'api',
	title: input.title.trim(),
	description: input.description.trim(),
	status: 'queued',
	tokensUsed: 0,
	createdAt: new Date(now()).toISOString(),
})

export const taskFromIssue = (
	issue: ResidentIssue,
	now: () => number = Date.now
): ResidentTask => ({
	id: newTaskId(),
	source: 'issue',
	issueNumber: issue.number,
	title: issue.title.trim(),
	description: issue.body.trim() || issue.title.trim(),
	status: 'queued',
	tokensUsed: 0,
	createdAt: new Date(now()).toISOString(),
})

const checklistLine = /^\s*[-*]\s*\[[ xX]?\]\s*(.+?)\s*$/

/** Markdown checklist items of a description (`- [ ] …`) — the acceptance criteria */
export const checklistItems = (description: string) =>
	description
		.split('\n')
		.map(line => checklistLine.exec(line)?.[1])
		.filter((item): item is string => Boolean(item))

/**
 * One task = one single-feature spec for the harness planner. Checklist lines are the
 * acceptance criteria (the M4 gates prove each one); without any, the task title is the single
 * criterion so the acceptance check still has something to hold the work against.
 */
export const specFromTask = (task: Pick<ResidentTask, 'title' | 'description'>): Spec => {
	const criteria = checklistItems(task.description)
	return {
		goal: task.title,
		users: [],
		features: [
			{
				title: task.title,
				description: task.description,
				acceptanceCriteria: criteria.length ? criteria : [task.title],
			},
		],
		nonGoals: ['Anything outside this task; keep the change minimal and focused'],
		stackConstraints: ["Follow the repository's existing conventions, tooling and CLAUDE.md"],
	}
}
