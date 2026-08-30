import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const script = new URL('../scripts/ensure-bootstrapped.sh', import.meta.url).pathname

/** Runs the guard with a fake `aws` (given exit code + stderr) and a fake `npx` that records its argv. */
function run(awsExit: number, awsStderr: string) {
	const bin = mkdtempSync(join(tmpdir(), 'ensure-bootstrapped-'))
	const npxLog = join(bin, 'npx.log')
	writeFileSync(
		join(bin, 'aws'),
		`#!/usr/bin/env bash\necho ${JSON.stringify(awsStderr)} >&2\nexit ${awsExit}\n`
	)
	writeFileSync(join(bin, 'npx'), `#!/usr/bin/env bash\necho "$*" >> ${JSON.stringify(npxLog)}\n`)
	chmodSync(join(bin, 'aws'), 0o755)
	chmodSync(join(bin, 'npx'), 0o755)
	const result = spawnSync('bash', [script, '123456789012', 'us-east-1'], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
	})
	const bootstraps = existsSync(npxLog) ? readFileSync(npxLog, 'utf8') : ''
	return { ...result, bootstraps }
}

test('skips bootstrap when the CDKToolkit stack exists', () => {
	const r = run(0, '')
	assert.equal(r.status, 0)
	assert.match(r.stdout, /already bootstrapped/)
	assert.equal(r.bootstraps, '')
})

test('bootstraps only when describe-stacks reports the stack does not exist', () => {
	const r = run(
		254,
		'An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id CDKToolkit does not exist'
	)
	assert.equal(r.status, 0)
	assert.match(r.stdout, /bootstrapping aws:\/\/123456789012\/us-east-1/)
	assert.equal(r.bootstraps, 'cdk bootstrap aws://123456789012/us-east-1\n')
})

test('fails loudly on any other describe-stacks error instead of bootstrapping', () => {
	const r = run(
		254,
		'An error occurred (AccessDenied) when calling the DescribeStacks operation: User is not authorized to perform cloudformation:DescribeStacks'
	)
	assert.equal(r.status, 1)
	assert.match(r.stderr, /cannot tell whether aws:\/\/123456789012\/us-east-1 is bootstrapped/)
	assert.match(r.stderr, /AccessDenied/)
	assert.equal(r.bootstraps, '')
})
