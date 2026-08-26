/* eslint-disable no-undef */
import { readFileSync } from 'fs'

const commitMsgFile = process.argv[2]
const commitMessage = readFileSync(commitMsgFile, 'utf8').trim()
const firstLine = commitMessage.split('\n')[0]

// Conventional Commits: https://www.conventionalcommits.org
const commitFormat =
	/^(Merge .*|Revert .*|(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([\w./-]+\))?!?: .+)$/

if (!commitFormat.test(firstLine)) {
	console.error('Your commit was rejected due to the commit message.')
	console.error('')
	console.error('Please use the Conventional Commits format:')
	console.error('* feat(scope): add something')
	console.error('* fix: correct something')
	console.error('* chore|docs|refactor|test|ci|build|perf|style: ...')
	console.error('')
	process.exit(1)
}
