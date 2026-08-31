// Teardown of the smoke-test delivery services on our dev account, via the REAL @mf/org
// deprovision engine wired exactly as apps/api/src/plugins/org.ts does it (tag-discovery + the
// ECS-Express delete handler). Dry-run by default; `--execute --slug=<customer>` for a real,
// customer-fenced teardown. Also dogfoods the deprovision path the backlog wanted exercised once.
import { readFileSync } from 'node:fs'

import { ECRClient } from '@aws-sdk/client-ecr'
import { DeleteExpressGatewayServiceCommand, ECSClient } from '@aws-sdk/client-ecs'
import { ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api'
import { S3Client } from '@aws-sdk/client-s3'

import { createAwsActuator, createTaggingDiscovery, deprovision } from '@mf/org'

// AWS creds from the root .env (never printed).
for (const line of readFileSync('/home/wsl/dev/mjukvarufabriken/.env', 'utf8').split('\n')) {
	const match = line.match(/^(AWS_[A-Z_]+)=(.*)$/)
	if (match) process.env[match[1]] = match[2].trim()
}
delete process.env.AWS_PROFILE
const region = process.env.AWS_REGION || 'eu-north-1'

const tagging = new ResourceGroupsTaggingAPIClient({ region })
const ecs = new ECSClient({ region })
const s3 = new S3Client({ region })
const ecr = new ECRClient({ region })

// The ECS-Express handler, identical to apps/api/src/plugins/org.ts (suspend == teardown: delete).
const deleteService = async arn => {
	await ecs.send(new DeleteExpressGatewayServiceCommand({ serviceArn: arn }))
	return { outcome: 'deleted', detail: { serviceArn: arn } }
}
const ecsExpressHandler = {
	suspend: resource => deleteService(resource.arn),
	teardown: resource => deleteService(resource.arn),
	resume: async () => ({ outcome: 'skipped', reason: 'ECS Express resume is a redelivery' }),
}

const discover = createTaggingDiscovery(tagging)
const actuator = createAwsActuator({ clients: { s3, ecr }, handlers: { ecs: ecsExpressHandler } })

const args = process.argv.slice(2)
const execute = args.includes('--execute')
const slug = args.find(a => a.startsWith('--slug='))?.split('=')[1]

// Safe Express teardown: discover by tag, act ONLY on the service/ ARNs (DeleteExpressGatewayService
// cascades task-def/tasks/ENIs/SG-rules/target-groups/listener-rules/autoscaling/alarms/cert), and
// never touch the shared gateway ALB or anything else. Bypasses the over-discovering engine.
if (args.includes('--delete-services')) {
	const all = await discover({ tags: {} })
	const services = all.filter(r => r.service === 'ecs' && r.arn.includes(':service/'))
	console.log(`\nExpress services to delete (${services.length}):`)
	for (const svc of services) console.log('  ' + svc.arn + `  Customer=${svc.tags.Customer ?? '(none)'}`)
	for (const svc of services) {
		try {
			await ecs.send(new DeleteExpressGatewayServiceCommand({ serviceArn: svc.arn }))
			console.log(`  DELETED ${svc.arn.split('/').pop()}`)
		} catch (e) {
			console.log(`  ${/not.?found|does not exist/i.test(e?.message ?? '') ? 'ALREADY-GONE' : 'FAILED'} ${svc.arn.split('/').pop()} — ${e?.message}`)
		}
	}
	process.exit(0)
}

const target = slug ? { customerSlug: slug, label: slug } : {}
const result = await deprovision(target, 'teardown', { discover, actuator, dryRun: !execute })

console.log(
	`\nmode=teardown  dryRun=${result.dryRun}  scope=${slug ?? '(all Service=mf-delivery)'}` +
		`\ndiscovered=${result.discovered}  fenced=${result.fenced}  skippedByFence=${result.skippedByFence}` +
		`\nsummary=${JSON.stringify(result.summary)}\n`
)
for (const entry of result.entries) {
	const customer = entry.detail?.tags?.Customer ?? ''
	console.log(
		`  ${String(entry.outcome).padEnd(11)} ${String(entry.service).padEnd(6)} ` +
			`${customer ? `[${customer}] ` : ''}${entry.arn}${entry.reason ? ` — ${entry.reason}` : ''}`
	)
}
