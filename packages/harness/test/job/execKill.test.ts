import { exec } from '#job/exec.ts'

import type { spawn as spawnType } from 'node:child_process'

// A child whose kill(2) is refused, as it is for a worker-uid process when the job holds no
// CAP_KILL: Node reports that as an 'error' event on the child, not as a thrown error
vi.mock('node:child_process', async importOriginal => {
	const actual = await importOriginal<{ spawn: typeof spawnType }>()
	return {
		...actual,
		spawn: (...args: Parameters<typeof actual.spawn>) => {
			const child = actual.spawn(...args)
			child.kill = () => {
				child.emit('error', Object.assign(new Error('kill EPERM'), { syscall: 'kill', code: 'EPERM' }))
				return false
			}
			return child
		},
	}
})

describe('exec when the kill is refused', () => {
	it('Resolves with the refusal in stderr instead of rejecting on a timeout', async () => {
		const result = await exec('sleep', ['1'], { cwd: process.cwd(), timeoutMs: 50 })
		expect(result.code).toBe(-1)
		expect(result.stderr).toContain('kill EPERM')
	})
})
