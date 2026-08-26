import { blockedBy, readyTasks, topologicalOrder, validateDag, waves } from '#job/dag.ts'

import type { Task } from '@mf/models'

const task = (id: string, dependsOn: string[] = []): Task => ({
	id,
	title: id,
	description: `do ${id}`,
	dependsOn,
	areas: [],
	acceptanceCriteriaIds: [],
})

describe('dag', () => {
	const diamond = [task('a'), task('b', ['a']), task('c', ['a']), task('d', ['b', 'c'])]

	describe('validateDag', () => {
		it('Accepts a diamond', () => {
			expect(validateDag(diamond)).toBeUndefined()
		})

		it('Rejects duplicate ids', () => {
			expect(validateDag([task('a'), task('a')])).toEqual({ kind: 'duplicateId', detail: 'a' })
		})

		it('Rejects unknown dependencies', () => {
			expect(validateDag([task('a', ['zzz'])])).toEqual({
				kind: 'unknownDependency',
				detail: 'a → zzz',
			})
		})

		it('Rejects cycles, including self-dependencies', () => {
			expect(validateDag([task('a', ['b']), task('b', ['a'])])?.kind).toBe('cycle')
			expect(validateDag([task('a', ['a'])])?.kind).toBe('cycle')
		})
	})

	describe('readyTasks / waves / topologicalOrder', () => {
		it('Returns only tasks whose dependencies are completed and that are not running', () => {
			expect(readyTasks(diamond, new Set(), new Set()).map(t => t.id)).toEqual(['a'])
			expect(readyTasks(diamond, new Set(['a']), new Set()).map(t => t.id)).toEqual(['b', 'c'])
			expect(readyTasks(diamond, new Set(['a']), new Set(['b'])).map(t => t.id)).toEqual(['c'])
			expect(readyTasks(diamond, new Set(['a', 'b']), new Set()).map(t => t.id)).toEqual(['c'])
		})

		it('Groups the diamond into three waves', () => {
			expect(waves(diamond).map(wave => wave.map(t => t.id))).toEqual([['a'], ['b', 'c'], ['d']])
		})

		it('Orders topologically, keeping plan order inside a wave', () => {
			expect(topologicalOrder(diamond).map(t => t.id)).toEqual(['a', 'b', 'c', 'd'])
		})

		it('Throws on a cycle instead of looping forever', () => {
			expect(() => waves([task('a', ['b']), task('b', ['a'])])).toThrow(/DAG/)
		})
	})

	describe('blockedBy', () => {
		it('Blocks transitive dependants of a failed task only', () => {
			expect([...blockedBy(diamond, new Set(['b']))]).toEqual(['d'])
			expect([...blockedBy(diamond, new Set(['a']))].toSorted()).toEqual(['b', 'c', 'd'])
			expect(blockedBy(diamond, new Set(['d'])).size).toBe(0)
		})
	})
})
