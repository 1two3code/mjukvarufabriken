/**
 * Local-only HTTP server the worker sandbox's `ANTHROPIC_BASE_URL` points at instead of the real
 * Anthropic API (hardening audit 2026-08-30, Gate B finding A1 — the root cause). It forwards
 * every request to the real Anthropic API, injecting the real key itself and discarding whatever
 * credential the caller sent — so the worker sandbox never needs the raw `ANTHROPIC_API_KEY` in
 * its own environment, only a harmless placeholder `ANTHROPIC_AUTH_TOKEN`, closing the path a
 * `Bash` tool call could otherwise read it through (`echo $ANTHROPIC_API_KEY`, or any other
 * process spawned as the worker uid, which inherits the same env).
 *
 * Binds to `127.0.0.1` only, so it is reachable from a process in the same task/container
 * (the worker sandbox runs as a different uid, but loopback networking is not uid-restricted)
 * and from nowhere outside it. The real key exists only in this process's own memory, in a
 * closure the request handler never exposes — a worker connecting here directly gains no more
 * than it already has (the model can already make requests through its own session), and cannot
 * exfiltrate the key value itself.
 */
import { createServer } from 'node:http'

import type { IncomingMessage, Server, ServerResponse } from 'node:http'

export type AnthropicForwardProxy = { url: string; close: () => Promise<void> }

export type StartAnthropicForwardProxyOptions = {
	/** The real Anthropic API key — never sent to the caller, only ever added to the upstream request */
	apiKey: string
	/** Overridable for tests: where requests are actually forwarded to */
	upstream?: string
	/** Injected in tests; defaults to the global fetch */
	fetchImpl?: typeof fetch
	/** 0 (default) binds an OS-assigned ephemeral port */
	port?: number
}

/** Headers a caller might send that must never reach upstream unmodified, or that Node re-derives itself */
const strippedRequestHeaders = /^(x-api-key|authorization|host|content-length)$/i
const strippedResponseHeaders = /^(content-length|transfer-encoding|connection)$/i

const readBody = (req: IncomingMessage): Promise<Buffer | undefined> =>
	new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on('data', chunk => chunks.push(chunk as Buffer))
		req.on('end', () => resolve(chunks.length ? Buffer.concat(chunks) : undefined))
		req.on('error', reject)
	})

const forwardHeaders = (req: IncomingMessage, apiKey: string) => {
	const headers = new Headers()
	for (const [key, value] of Object.entries(req.headers)) {
		if (!value || strippedRequestHeaders.test(key)) continue
		headers.set(key, Array.isArray(value) ? value.join(', ') : value)
	}
	headers.set('x-api-key', apiKey)
	return headers
}

const handleRequest = async (
	req: IncomingMessage,
	res: ServerResponse,
	{ apiKey, upstream, fetchImpl }: Required<Omit<StartAnthropicForwardProxyOptions, 'port'>>
) => {
	try {
		const body = await readBody(req)
		const upstreamResponse = await fetchImpl(`${upstream}${req.url ?? ''}`, {
			method: req.method,
			headers: forwardHeaders(req, apiKey),
			body,
		})
		const responseHeaders: Record<string, string> = {}
		upstreamResponse.headers.forEach((value, key) => {
			if (!strippedResponseHeaders.test(key)) responseHeaders[key] = value
		})
		res.writeHead(upstreamResponse.status, responseHeaders)
		if (!upstreamResponse.body) return void res.end()
		for await (const chunk of upstreamResponse.body) res.write(chunk)
		res.end()
	} catch (error) {
		if (res.headersSent) return void res.end()
		res.writeHead(502, { 'content-type': 'application/json' })
		res.end(
			JSON.stringify({
				type: 'error',
				error: {
					type: 'api_error',
					message: `anthropic-forward-proxy: upstream request failed: ${(error as Error).message}`,
				},
			})
		)
	}
}

export const startAnthropicForwardProxy = ({
	apiKey,
	upstream = 'https://api.anthropic.com',
	fetchImpl = fetch,
	port = 0,
}: StartAnthropicForwardProxyOptions): Promise<AnthropicForwardProxy> => {
	const server: Server = createServer((req, res) => {
		void handleRequest(req, res, { apiKey, upstream, fetchImpl })
	})
	return new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, '127.0.0.1', () => {
			const address = server.address()
			if (!address || typeof address === 'string') {
				reject(new Error('anthropic-forward-proxy: failed to bind a port'))
				return
			}
			resolve({
				url: `http://127.0.0.1:${address.port}`,
				close: () => new Promise(closed => server.close(() => closed())),
			})
		})
	})
}
