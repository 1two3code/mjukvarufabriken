import {
	assumeRolePolicy,
	prefixPolicy,
	previewPrefix,
	previewRoleName,
} from '#/services/previewStorageService.ts'

const jobId = '11111111-2222-3333-4444-555555555555'

describe('preview storage naming', () => {
	it('derives the role name and the prefix from the SAME token', () => {
		// The policy grants the role its prefix, so two independent derivations of "which job" is a
		// way for a role to end up scoped to somebody else's keys.
		const role = previewRoleName(jobId)
		const prefix = previewPrefix(jobId)
		const token = role.replace('mf-preview-app-', '')
		expect(prefix).toBe(`preview/${token}/`)
	})

	it('always produces a name matching the IAM grant pattern', () => {
		// The api's own grant is fenced to `mf-preview-app-*` under `/mf-preview/`; a name outside
		// that shape would simply be denied by IAM, so it must be impossible to produce one.
		for (const id of [jobId, 'ABCD-EFGH-IJKL', 'a1b2c3d4e5f6a7b8c9d0']) {
			expect(previewRoleName(id)).toMatch(/^mf-preview-app-[a-z0-9]{4,24}$/)
		}
	})

	it('is deterministic, so a redelivery reuses its role instead of leaking one per attempt', () => {
		expect(previewRoleName(jobId)).toBe(previewRoleName(jobId))
		expect(previewPrefix(jobId)).toBe(previewPrefix(jobId))
	})

	it('refuses a job id too short to derive a distinct name', () => {
		expect(() => previewRoleName('a-b')).toThrow(/too short/)
		expect(() => previewPrefix('a-b')).toThrow(/too short/)
	})

	it('ends the prefix with a slash so one app cannot match another by name prefix', () => {
		// `preview/abc` without the slash also matches `preview/abcdef/...`
		expect(previewPrefix(jobId).endsWith('/')).toBe(true)
	})
})

describe('preview storage policies', () => {
	const bucket = 'mf-preview-dev'
	const prefix = previewPrefix(jobId)

	it('grants object actions only under the app’s own prefix', () => {
		const policy = JSON.parse(prefixPolicy(bucket, prefix)) as {
			Statement: { Effect: string; Action: string | string[]; Resource: string }[]
		}
		const objects = policy.Statement.find(statement => statement.Resource.includes('/preview/'))
		expect(objects?.Resource).toBe(`arn:aws:s3:::${bucket}/${prefix}*`)
		expect(objects?.Effect).toBe('Allow')
		// No bucket-wide or account-wide reach
		const serialised = JSON.stringify(policy)
		expect(serialised).not.toContain('"*"')
		expect(serialised).not.toContain(`arn:aws:s3:::${bucket}/*`)
	})

	it('fences ListBucket by prefix, or listing would reveal every other app’s keys', () => {
		const policy = JSON.parse(prefixPolicy(bucket, prefix)) as {
			Statement: { Action: string | string[]; Condition?: Record<string, Record<string, string[]>> }[]
		}
		const list = policy.Statement.find(statement =>
			[statement.Action].flat().includes('s3:ListBucket')
		)
		expect(list?.Condition?.StringLike?.['s3:prefix']).toEqual([`${prefix}*`])
	})

	it('grants no write to the bucket policy, ACLs or other buckets', () => {
		const actions = (
			JSON.parse(prefixPolicy(bucket, prefix)) as { Statement: { Action: string | string[] }[] }
		).Statement.flatMap(statement => [statement.Action].flat())
		for (const forbidden of ['s3:PutBucketPolicy', 's3:PutObjectAcl', 's3:*']) {
			expect(actions).not.toContain(forbidden)
		}
	})

	it('lets only ECS tasks in this account assume the role', () => {
		const trust = JSON.parse(assumeRolePolicy('123456789012')) as {
			Statement: {
				Principal: { Service: string }
				Action: string
				Condition: Record<string, Record<string, string>>
			}[]
		}
		expect(trust.Statement[0]?.Principal.Service).toBe('ecs-tasks.amazonaws.com')
		expect(trust.Statement[0]?.Action).toBe('sts:AssumeRole')
		// The confused-deputy guard: another account's ECS must not be able to assume it
		expect(trust.Statement[0]?.Condition.StringEquals['aws:SourceAccount']).toBe('123456789012')
	})
})
