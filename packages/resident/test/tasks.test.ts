import { SpecSchema } from '@mf/models'

import { branchOf, checklistItems, specFromTask, taskFromInput, taskFromIssue } from '#/tasks.ts'

describe('tasks', () => {
	it('Turns a labelled issue into a queued task with a branch-safe id', () => {
		const task = taskFromIssue(
			{ number: 12, title: '  Add search ', body: 'Users search products', labels: ['resident'] },
			() => Date.parse('2026-09-03T12:00:00.000Z')
		)
		expect(task).toMatchObject({
			source: 'issue',
			issueNumber: 12,
			title: 'Add search',
			description: 'Users search products',
			status: 'queued',
			tokensUsed: 0,
			createdAt: '2026-09-03T12:00:00.000Z',
		})
		expect(task.id).toMatch(/^[a-f0-9]{8}$/)
		expect(branchOf(task)).toBe(`resident/${task.id}`)
		// An empty body falls back to the title so the worker always has a description
		expect(taskFromIssue({ number: 1, title: 'Fix typo', body: '', labels: [] }).description).toBe(
			'Fix typo'
		)
	})

	it('Makes checklist lines the acceptance criteria of a single-feature spec', () => {
		const task = taskFromInput({
			title: 'Add search',
			description:
				'Search box on the products page.\n- [ ] Typing filters the list\n* [x] Empty query shows all\n- not a checkbox',
		})
		expect(checklistItems(task.description)).toEqual([
			'Typing filters the list',
			'Empty query shows all',
		])
		const spec = specFromTask(task)
		expect(SpecSchema.parse(spec)).toEqual(spec)
		expect(spec.goal).toBe('Add search')
		expect(spec.features).toHaveLength(1)
		expect(spec.features[0]!.acceptanceCriteria).toEqual([
			'Typing filters the list',
			'Empty query shows all',
		])
		// Without a checklist the title is the one criterion
		expect(
			specFromTask({ title: 'Fix typo', description: 'In the footer' }).features[0]!
				.acceptanceCriteria
		).toEqual(['Fix typo'])
	})
})
