import { startAnthropicForwardProxy } from '#/anthropicForwardProxy.ts'

import type { AnthropicForwardProxy } from '#/anthropicForwardProxy.ts'

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
