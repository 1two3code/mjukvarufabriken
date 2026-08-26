import { acceptanceCheckGate, acceptanceTestsGate, reviewGate } from './gateSessions.ts'
import { mergeTask } from './merge.ts'
import { createPlanner } from './planner.ts'
import { runTask, verifyRepo } from './worker.ts'

import type { SpecEngineClient } from '#spec/specEngine.ts'
import type { OrchestratorPorts } from './types.ts'

export type LivePortsOptions = {
	/** Anthropic SDK client for the planner (the workers use the Agent SDK with `ANTHROPIC_API_KEY`) */
	client: SpecEngineClient
	planModel?: string
	workerModel?: string
}

/** The real planner / Agent SDK workers / git merge / lint+test verification / M4 gate sessions */
export const createLivePorts = ({
	client,
	planModel,
	workerModel,
}: LivePortsOptions): OrchestratorPorts => {
	const planner = createPlanner({ client, model: planModel })
	return {
		plan: input => planner.plan(input),
		runTask: input => runTask({ ...input, model: workerModel }),
		mergeTask: input => mergeTask({ ...input, model: workerModel }),
		verify: ({ repoDir, signal }) => verifyRepo(repoDir, signal),
		acceptanceTests: input => acceptanceTestsGate(input, { model: workerModel }),
		review: input => reviewGate(input, { model: workerModel }),
		acceptanceCheck: input => acceptanceCheckGate(input, { model: workerModel }),
	}
}
