import fp from 'fastify-plugin'
import { toIterationBriefSpecSeed } from '@mf/models'

import { EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyPluginAsync } from 'fastify'
import type {
	BackendSession,
	IterationBrief,
	IterationBriefEntry,
	IterationBriefSpecSeed,
	NewIterationBriefEntry,
} from '@mf/models'

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * The resident LLM's structured iteration brief per customer org and project (M11,
		 * docs/backlog/environments.md): open questions + answers + decisions + context that go
		 * beyond frontend, accumulated across the live dev loop and exported as the seed for the
		 * next full factory build. Everything is scoped to the session's org (admins see every
		 * org); `projectId` is the delivered app / order id. DATA + API foundation only — the live
		 * resident-LLM wiring is later M11.
		 */
		iterationBriefService: {
			/** The org's brief for the project; throws `EntityNotFound` when there is none yet */
			get: (projectId: string, session: BackendSession) => Promise<IterationBrief>
			/** The org's briefs, most recently updated first (admins see every org) */
			list: (session: BackendSession) => Promise<IterationBrief[]>
			/**
			 * Appends an entry to the org's project brief (creating it on first contact). The api
			 * mints the entry id and timestamp; `title` names the brief when it is created.
			 */
			appendEntry: (
				projectId: string,
				input: NewIterationBriefEntry,
				session: BackendSession,
				title?: string
			) => Promise<IterationBrief>
			/**
			 * The brief projected into a spec-engine seed (the `@mf/harness` planner consumes a
			 * `SpecDraft`-shaped input): partial spec + open questions + decisions + context. Throws
			 * `EntityNotFound` when the project has no brief.
			 */
			exportSpecSeed: (
				projectId: string,
				session: BackendSession
			) => Promise<IterationBriefSpecSeed>
		}
	}
}

const isAdmin = (session: BackendSession) => session.role === 'admin'

const plugin: FastifyPluginAsync = async app => {
	const { db } = app

	/** Org-scoped read: another org's brief reads as not found (admins see all) */
	const scopedGet = async (projectId: string, session: BackendSession) => {
		const brief = await db.iterationBrief.get(session.orgId, projectId)
		if (!brief || (!isAdmin(session) && brief.orgId !== session.orgId)) {
			throw new EntityNotFound('iterationBrief', projectId)
		}
		return brief
	}

	app.decorate('iterationBriefService', {
		get: scopedGet,
		list: async session => db.iterationBrief.list(isAdmin(session) ? undefined : session.orgId),
		appendEntry: async (projectId, input, session, title) => {
			const entry: IterationBriefEntry = {
				id: crypto.randomUUID(),
				kind: input.kind,
				topic: input.topic,
				body: input.body,
				answersEntryId: input.answersEntryId,
				author: input.author,
				createdAt: new Date().toISOString(),
			}
			const brief = await db.iterationBrief.appendEntry(session.orgId, projectId, entry, title)
			app.log.info(
				{ orgId: session.orgId, projectId, kind: entry.kind, topic: entry.topic },
				'iteration brief entry appended'
			)
			return brief
		},
		exportSpecSeed: async (projectId, session) =>
			toIterationBriefSpecSeed(await scopedGet(projectId, session)),
	})
}

export default fp(plugin, {
	name: '#internal/iterationBriefService',
	dependencies: ['#internal/db'],
})
