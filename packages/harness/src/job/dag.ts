import type { Task } from '@mf/models'

/** Pure DAG helpers over a plan's tasks — no I/O, fully unit-tested. */

export type DagError = { kind: 'unknownDependency' | 'duplicateId' | 'cycle'; detail: string }

const byId = (tasks: Task[]) => new Map(tasks.map(task => [task.id, task]))

/** Returns the first structural problem, or undefined when the tasks form a valid DAG */
export const validateDag = (tasks: Task[]): DagError | undefined => {
	const ids = new Set<string>()
	for (const task of tasks) {
		if (ids.has(task.id)) return { kind: 'duplicateId', detail: task.id }
		ids.add(task.id)
	}
	for (const task of tasks) {
		for (const dep of task.dependsOn) {
			if (!ids.has(dep)) return { kind: 'unknownDependency', detail: `${task.id} → ${dep}` }
		}
	}
	const cycle = findCycle(tasks)
	return cycle ? { kind: 'cycle', detail: cycle.join(' → ') } : undefined
}

/** Depth-first cycle search; returns the cycle path when one exists */
const findCycle = (tasks: Task[]): string[] | undefined => {
	const map = byId(tasks)
	const state = new Map<string, 'visiting' | 'done'>()
	const stack: string[] = []

	const visit = (id: string): string[] | undefined => {
		const current = state.get(id)
		if (current === 'done') return undefined
		if (current === 'visiting') return [...stack.slice(stack.indexOf(id)), id]
		state.set(id, 'visiting')
		stack.push(id)
		for (const dep of map.get(id)?.dependsOn ?? []) {
			const found = visit(dep)
			if (found) return found
		}
		stack.pop()
		state.set(id, 'done')
		return undefined
	}

	for (const task of tasks) {
		const found = visit(task.id)
		if (found) return found
	}
	return undefined
}

/**
 * Tasks whose dependencies are all in `completed` and that are neither completed nor running,
 * in plan order (the planner lists tasks roughly by priority).
 */
export const readyTasks = (tasks: Task[], completed: Set<string>, running: Set<string>) =>
	tasks.filter(
		task =>
			!completed.has(task.id) &&
			!running.has(task.id) &&
			task.dependsOn.every(dep => completed.has(dep))
	)

/** Groups tasks into waves: wave n contains tasks whose dependencies are all in waves < n */
export const waves = (tasks: Task[]): Task[][] => {
	const result: Task[][] = []
	const completed = new Set<string>()
	while (completed.size < tasks.length) {
		const wave = readyTasks(tasks, completed, new Set())
		if (!wave.length) throw new Error('waves: tasks do not form a DAG')
		result.push(wave)
		wave.forEach(task => completed.add(task.id))
	}
	return result
}

/** Topological order that respects plan order within a wave — the order branches are merged */
export const topologicalOrder = (tasks: Task[]): Task[] => waves(tasks).flat()

/** Ids that can never run because a dependency (transitively) failed */
export const blockedBy = (tasks: Task[], failed: Set<string>): Set<string> => {
	const blocked = new Set<string>()
	let changed = true
	while (changed) {
		changed = false
		for (const task of tasks) {
			if (blocked.has(task.id) || failed.has(task.id)) continue
			if (task.dependsOn.some(dep => failed.has(dep) || blocked.has(dep))) {
				blocked.add(task.id)
				changed = true
			}
		}
	}
	return blocked
}
