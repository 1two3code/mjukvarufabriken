import fp from 'fastify-plugin'
import Anthropic from '@anthropic-ai/sdk'

import type { FastifyPluginAsync } from 'fastify'
import type { SpecEngineClient } from '@mf/harness'

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * Anthropic SDK client, narrowed to what the harness uses. Model calls are made by
		 * `@mf/harness`, never directly from routes or services.
		 */
		anthropic: SpecEngineClient
	}
}

export class AnthropicNotConfigured extends Error {
	constructor() {
		super('Anthropic API key is not configured (ANTHROPIC_API_KEY / ANTHROPIC_API_KEY_SECRET_ARN)')
	}
}

/** Stand-in used when no key is configured so the api boots and fails per request instead */
const createUnavailableClient = (): SpecEngineClient => ({
	messages: { create: async () => Promise.reject(new AnthropicNotConfigured()) },
})

const plugin: FastifyPluginAsync = async app => {
	const { anthropicApiKey } = app.secrets

	if (!anthropicApiKey) {
		app.log.warn('Anthropic API key not configured — spec engine unavailable')
		app.decorate('anthropic', createUnavailableClient())
		return
	}

	app.decorate('anthropic', new Anthropic({ apiKey: anthropicApiKey }))
}

export default fp(plugin, { name: '#internal/anthropic', dependencies: ['#internal/secrets'] })
