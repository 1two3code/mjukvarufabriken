import { deliver } from './delivery/deliver.ts'
import { acceptanceCheckGate, acceptanceTestsGate, reviewGate } from './gateSessions.ts'
import { licenceGate } from './gates/licence.ts'
import { mergeTask } from './merge.ts'
import { createPlanner, resolvePlanModel } from './planner.ts'
import { resolveWorkerModel, runTask, verifyRepo } from './worker.ts'

import type { SpecEngineClient } from '#spec/specEngine.ts'
import type { DeliveryClients } from './delivery/types.ts'
import type { OnUsage, OrchestratorPorts } from './types.ts'

export type LivePortsOptions = {
	/** Anthropic SDK client for the planner (the workers use the Agent SDK with `ANTHROPIC_API_KEY`) */
	client: SpecEngineClient
	planModel?: string
	workerModel?: string
	/** M5 delivery clients (GitHub, ECS Express, S3); omitted → the job stops after the gates */
	delivery?: DeliveryClients
}

/** Attribute every usage sample a port reports to the model that port runs (billing per model) */
const tagged = <T extends { onUsage: OnUsage }>(input: T, model: string): T => ({
	...input,
	onUsage: (usage, reported) => input.onUsage(usage, reported ?? model),
})

/** The real planner / Agent SDK workers / git merge / lint+test verification / M4 gate sessions */
export const createLivePorts = ({
	client,
	planModel,
	workerModel,
	delivery,
}: LivePortsOptions): OrchestratorPorts => {
	const planner = createPlanner({ client, model: planModel })
	const plannerId = resolvePlanModel(planModel)
	const workerId = resolveWorkerModel(workerModel)
	return {
		plan: input => planner.plan(tagged(input, plannerId)),
		runTask: input => runTask({ ...tagged(input, workerId), model: workerModel }),
		mergeTask: input => mergeTask({ ...tagged(input, workerId), model: workerModel }),
		verify: ({ repoDir, signal }) => verifyRepo(repoDir, signal),
		acceptanceTests: input => acceptanceTestsGate(tagged(input, workerId), { model: workerModel }),
		review: input => reviewGate(tagged(input, workerId), { model: workerModel }),
		licence: input => licenceGate(input),
		acceptanceCheck: input => acceptanceCheckGate(tagged(input, workerId), { model: workerModel }),
		deliver: delivery ? input => deliver(tagged(input, workerId), delivery) : undefined,
	}
}
