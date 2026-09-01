import { startAnthropicForwardProxy } from '#/anthropicForwardProxy.ts'

import type { AnthropicForwardProxy, ProxyUsageSample } from '#/anthropicForwardProxy.ts'

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined }

/** An upstream fetch stub that records calls and replays the queued responses (last one repeats) */
const createUpstreamStub = (responses: (() => Response)[]) => {
	const calls: Call[] = []
	const queue = [...responses]
	const fetchStub = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const headers: Record<string, string> = {}
		new Headers(init?.headers).forEach((value, key) => (headers[key] = value))
		calls.push({
			url: String(url),
			method: init?.method ?? 'GET',
			headers,
			body: init?.body === undefined ? undefined : String(init.body),
		})
		const next = queue.length > 1 ? queue.shift()! : queue[0]!
		return next()
	}) as unknown as typeof fetch
	return { fetchStub, calls }
}

const jsonResponse = (body: unknown, status = 200) => () =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('Anthropic forward proxy', () => {
	let proxy: AnthropicForwardProxy | undefined

	afterEach(async () => {
		await proxy?.close()
		proxy = undefined
	})

	it('Injects the real key and strips whatever credential the caller sent', async () => {
		// Arrange
		const { fetchStub, calls } = createUpstreamStub([jsonResponse({ id: 'msg_1' })])
		proxy = await startAnthropicForwardProxy({ apiKey: 'sk-ant-REAL-SECRET', fetchImpl: fetchStub })

		// Act
		await fetch(`${proxy.url}/v1/messages`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-api-key': 'sk-ant-FORGED-BY-CALLER',
				authorization: 'Bearer forged-token',
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({ model: 'claude-sonnet-5', messages: [] }),
		})

		// Assert
		expect(calls).toHaveLength(1)
		expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages')
		expect(calls[0]!.method).toBe('POST')
		expect(calls[0]!.headers['x-api-key']).toBe('sk-ant-REAL-SECRET')
		expect(calls[0]!.headers['authorization']).toBeUndefined()
		expect(calls[0]!.headers['anthropic-version']).toBe('2023-06-01')
		expect(JSON.parse(calls[0]!.body!)).toEqual({ model: 'claude-sonnet-5', messages: [] })
	})

	it('Never lets the caller learn the real key from the response either', async () => {
		// Arrange
		const { fetchStub } = createUpstreamStub([jsonResponse({ id: 'msg_1' })])
		proxy = await startAnthropicForwardProxy({ apiKey: 'sk-ant-REAL-SECRET', fetchImpl: fetchStub })

		// Act
		const response = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' })
		const text = await response.text()

		// Assert
		expect(text).not.toContain('sk-ant-REAL-SECRET')
		expect(JSON.parse(text)).toEqual({ id: 'msg_1' })
	})

	it('Relays a streamed (SSE-style) response body verbatim, chunk by chunk', async () => {
		// Arrange
		const chunks = [
			'event: message_start\ndata: {"type":"message_start"}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		]
		const stream = new ReadableStream({
			async start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(new TextEncoder().encode(chunk))
					await new Promise(resolve => setTimeout(resolve, 5)) // force separate writes, not one flush
				}
				controller.close()
			},
		})
		const { fetchStub } = createUpstreamStub([
			() => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
		])
		proxy = await startAnthropicForwardProxy({ apiKey: 'sk-ant-REAL-SECRET', fetchImpl: fetchStub })

		// Act
		const response = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' })
		const text = await response.text()

		// Assert
		expect(response.headers.get('content-type')).toBe('text/event-stream')
		expect(text).toBe(chunks.join(''))
	})

	it('Forwards a non-2xx upstream status and body as is', async () => {
		// Arrange
		const { fetchStub } = createUpstreamStub([
			jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, 400),
		])
		proxy = await startAnthropicForwardProxy({ apiKey: 'sk-ant-REAL-SECRET', fetchImpl: fetchStub })

		// Act
		const response = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' })

		// Assert
		expect(response.status).toBe(400)
		expect(await response.json()).toEqual({
			type: 'error',
			error: { type: 'invalid_request_error', message: 'bad' },
		})
	})

	it('Answers 502 instead of hanging or crashing when the upstream call itself fails', async () => {
		// Arrange
		const fetchStub = vi.fn(() => Promise.reject(new Error('network unreachable'))) as unknown as typeof fetch
		proxy = await startAnthropicForwardProxy({ apiKey: 'sk-ant-REAL-SECRET', fetchImpl: fetchStub })

		// Act
		const response = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' })

		// Assert
		expect(response.status).toBe(502)
		const body = (await response.json()) as { error: { message: string } }
		expect(body.error.message).toContain('network unreachable')
	})

	// MARK: D1 spend metering — the proxy is the budget's chokepoint for out-of-band calls too

	it('Reports the usage block and model of a JSON response (never an estimate)', async () => {
		// Arrange
		const samples: ProxyUsageSample[] = []
		const { fetchStub } = createUpstreamStub([
			jsonResponse({
				id: 'msg_1',
				model: 'claude-sonnet-5',
				usage: {
					input_tokens: 120,
					output_tokens: 45,
					cache_read_input_tokens: 900,
					cache_creation_input_tokens: 30,
				},
			}),
		])
		proxy = await startAnthropicForwardProxy({
			apiKey: 'sk-ant-REAL-SECRET',
			fetchImpl: fetchStub,
			onUsage: sample => samples.push(sample),
		})

		// Act
		await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: '{"model":"x"}' })

		// Assert
		expect(samples).toHaveLength(1)
		expect(samples[0]!.usage).toEqual({
			inputTokens: 120,
			outputTokens: 45,
			cacheReadInputTokens: 900,
			cacheCreationInputTokens: 30,
		})
		expect(samples[0]!.model).toBe('claude-sonnet-5')
		expect(samples[0]!.estimated).toBe(false)
		expect(samples[0]!.status).toBe(200)
		expect(samples[0]!.requestBytes).toBeGreaterThan(0)
		expect(samples[0]!.responseBytes).toBeGreaterThan(0)
	})

	it('Merges usage across an SSE stream: input from message_start, output from the last delta', async () => {
		// Arrange
		const samples: ProxyUsageSample[] = []
		const chunks = [
			`event: message_start\ndata: ${JSON.stringify({
				type: 'message_start',
				message: {
					model: 'claude-haiku-4-5',
					usage: { input_tokens: 200, output_tokens: 1, cache_read_input_tokens: 1000 },
				},
			})}\n\n`,
			'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n',
			`event: message_delta\ndata: ${JSON.stringify({
				type: 'message_delta',
				usage: { output_tokens: 77 },
			})}\n\n`,
		]
		const stream = new ReadableStream({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
				controller.close()
			},
		})
		const { fetchStub } = createUpstreamStub([
			() => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
		])
		proxy = await startAnthropicForwardProxy({
			apiKey: 'sk-ant-REAL-SECRET',
			fetchImpl: fetchStub,
			onUsage: sample => samples.push(sample),
		})

		// Act
		await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' })

		// Assert
		expect(samples).toHaveLength(1)
		expect(samples[0]!.usage).toEqual({
			inputTokens: 200,
			outputTokens: 77,
			cacheReadInputTokens: 1000,
			cacheCreationInputTokens: 0,
		})
		expect(samples[0]!.model).toBe('claude-haiku-4-5')
		expect(samples[0]!.estimated).toBe(false)
	})

	it('Estimates tokens from bytes when a 2xx response carries no usage — no call is free', async () => {
		// Arrange
		const samples: ProxyUsageSample[] = []
		const { fetchStub } = createUpstreamStub([jsonResponse({ id: 'msg_1' })])
		proxy = await startAnthropicForwardProxy({
			apiKey: 'sk-ant-REAL-SECRET',
			fetchImpl: fetchStub,
			onUsage: sample => samples.push(sample),
		})

		// Act
		const body = 'x'.repeat(400)
		await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body })

		// Assert
		expect(samples).toHaveLength(1)
		expect(samples[0]!.estimated).toBe(true)
		const expectedTokens = Math.ceil((samples[0]!.requestBytes + samples[0]!.responseBytes) / 4)
		expect(samples[0]!.usage.inputTokens).toBe(expectedTokens)
		expect(samples[0]!.usage.inputTokens).toBeGreaterThanOrEqual(100)
	})

	it('Reports zero usage (not an estimate) for a non-2xx response and for an upstream failure', async () => {
		// Arrange
		const samples: ProxyUsageSample[] = []
		const failingFetch = vi.fn(() => Promise.reject(new Error('network unreachable'))) as unknown as typeof fetch
		const { fetchStub } = createUpstreamStub([
			jsonResponse({ type: 'error', error: { type: 'invalid_request_error', message: 'bad' } }, 400),
		])
		proxy = await startAnthropicForwardProxy({
			apiKey: 'sk-ant-REAL-SECRET',
			fetchImpl: fetchStub,
			onUsage: sample => samples.push(sample),
		})
		const failingProxy = await startAnthropicForwardProxy({
			apiKey: 'sk-ant-REAL-SECRET',
			fetchImpl: failingFetch,
			onUsage: sample => samples.push(sample),
		})

		// Act
		await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' })
		await fetch(`${failingProxy.url}/v1/messages`, { method: 'POST', body: '{}' })
		await failingProxy.close()

		// Assert
		expect(samples).toHaveLength(2)
		expect(samples[0]!).toMatchObject({
			status: 400,
			estimated: false,
			usage: { inputTokens: 0, outputTokens: 0 },
		})
		expect(samples[1]!).toMatchObject({
			status: 502,
			estimated: false,
			usage: { inputTokens: 0, outputTokens: 0 },
		})
	})

	it('Keeps relaying when the metering callback itself throws', async () => {
		// Arrange
		const { fetchStub } = createUpstreamStub([jsonResponse({ id: 'msg_1' })])
		proxy = await startAnthropicForwardProxy({
			apiKey: 'sk-ant-REAL-SECRET',
			fetchImpl: fetchStub,
			onUsage: () => {
				throw new Error('meter sink crashed')
			},
		})

		// Act
		const response = await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: '{}' })

		// Assert
		expect(response.status).toBe(200)
		expect(await response.json()).toEqual({ id: 'msg_1' })
	})

	it('Stops accepting connections once closed', async () => {
		// Arrange
		const { fetchStub } = createUpstreamStub([jsonResponse({ id: 'msg_1' })])
		proxy = await startAnthropicForwardProxy({ apiKey: 'sk-ant-REAL-SECRET', fetchImpl: fetchStub })
		const url = proxy.url

		// Act
		await proxy.close()
		proxy = undefined

		// Assert
		await expect(fetch(`${url}/v1/messages`, { method: 'POST', body: '{}' })).rejects.toThrow()
	})
})
