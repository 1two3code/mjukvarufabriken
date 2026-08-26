import { deliver } from './delivery/deliver.ts'
import { acceptanceCheckGate, acceptanceTestsGate, reviewGate } from './gateSessions.ts'
import { licenceGate } from './gates/licence.ts'
import { mergeTask } from './merge.ts'
import { createPlanner } from './planner.ts'
import { runTask, verifyRepo } from './worker.ts'

import type { SpecEngineClient } from '#spec/specEngine.ts'
import type { DeliveryClients } from './delivery/types.ts'
import type { OrchestratorPorts } from './types.ts'

export type LivePortsOptions = {
	/** Anthropic SDK client for the planner (the workers use the Agent SDK with `ANTHROPIC_API_KEY`) */
	client: SpecEngineClient
	planModel?: string
	workerModel?: string
	/** M5 delivery clients (GitHub, App Runner, S3); omitted → the job stops after the gates */
	delivery?: DeliveryClients
}

/** The real planner / Agent SDK workers / git merge / lint+test verification / M4 gate sessions */
export const createLivePorts = ({
	client,
	planModel,
	workerModel,
	delivery,
}: LivePortsOptions): OrchestratorPorts => {
	const planner = createPlanner({ client, model: planModel })
	return {
		plan: input => planner.plan(input),
		runTask: input => runTask({ ...input, model: workerModel }),
		mergeTask: input => mergeTask({ ...input, model: workerModel }),
		verify: ({ repoDir, signal }) => verifyRepo(repoDir, signal),
		acceptanceTests: input => acceptanceTestsGate(input, { model: workerModel }),
		review: input => reviewGate(input, { model: workerModel }),
		licence: input => licenceGate(input),
		acceptanceCheck: input => acceptanceCheckGate(input, { model: workerModel }),
		deliver: delivery ? input => deliver(input, delivery) : undefined,
	}
}
