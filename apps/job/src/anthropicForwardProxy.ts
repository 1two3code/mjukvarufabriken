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
 *
 * SPEND METERING (Gate B finding D1): the proxy is the one chokepoint every Anthropic request
 * passes — the Agent SDK sessions' own traffic AND any out-of-band `curl` a prompt-injected
 * worker fires at `ANTHROPIC_BASE_URL` directly. Each relayed response is parsed for its `usage`
 * block (JSON bodies and SSE streams both); when a 2xx response carries none, tokens are
 * estimated from the request+response byte count so no call is ever free. Every sample goes to
 * the `onUsage` callback, which apps/job feeds into the job's `BudgetTracker` — out-of-band
 * spend burns the same budget and trips the same kill-switch as SDK usage.
 */
import { createServer } from 'node:http'

import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { TokenUsage } from '@mf/harness'

export type AnthropicForwardProxy = { url: string; close: () => Promise<void> }

/** One relayed request's observed spend, reported to `onUsage` after the response finished */
export type ProxyUsageSample = {
	/** Four-bucket usage parsed from the upstream response, or a byte-based estimate */
	usage: TokenUsage
	/** Model id from the response, when it carried one */
	model?: string
	/** True when no `usage` block could be parsed and tokens were estimated from bytes */
	estimated: boolean
	requestBytes: number
	responseBytes: number
	/** Upstream HTTP status; 502 when the upstream call itself failed (zero usage) */
	status: number
}

export type StartAnthropicForwardProxyOptions = {
	/** The real Anthropic API key — never sent to the caller, only ever added to the upstream request */
	apiKey: string
	/** Called once per relayed request with its observed spend (D1 metering); errors are swallowed */
	onUsage?: (sample: ProxyUsageSample) => void
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

/**
 * Fallback pricing when a 2xx response carries no parseable usage: ~4 bytes/token over the
 * request + response payloads. Deliberately rough — it exists so an unparseable call is never
 * free to the budget, not to bill accurately (real usage blocks are parsed whenever present).
 */
const estimateBytesPerToken = 4

/** JSON bodies larger than this are not buffered for usage parsing (the estimate covers them) */
const jsonParseCapBytes = 4 * 1024 * 1024

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

// MARK: Usage parsing (D1)

/** Snake-case API usage object → four-bucket `TokenUsage`, or undefined when it is not one */
const usageFrom = (value: unknown): TokenUsage | undefined => {
	if (typeof value !== 'object' || value === null) return undefined
	const raw = value as Record<string, unknown>
	const bucket = (key: string) => (typeof raw[key] === 'number' ? (raw[key] as number) : undefined)
	const inputTokens = bucket('input_tokens')
	const outputTokens = bucket('output_tokens')
	if (inputTokens === undefined && outputTokens === undefined) return undefined
	return {
		inputTokens: inputTokens ?? 0,
		outputTokens: outputTokens ?? 0,
		cacheReadInputTokens: bucket('cache_read_input_tokens') ?? 0,
		cacheCreationInputTokens: bucket('cache_creation_input_tokens') ?? 0,
	}
}

type ParsedUsage = { usage?: TokenUsage; model?: string }

/** `usage`/`model` of a non-streaming JSON response body (a `/v1/messages` result) */
const parseJsonUsage = (body: Buffer): ParsedUsage => {
	try {
		const parsed = JSON.parse(body.toString('utf8')) as { usage?: unknown; model?: unknown }
		return {
			usage: usageFrom(parsed.usage),
			model: typeof parsed.model === 'string' ? parsed.model : undefined,
		}
	} catch {
		return {}
	}
}

/**
 * Incremental SSE usage parser: feed the raw stream through `push`, read the merged result at
 * the end. Only complete `data:` lines are parsed (memory stays bounded by one line, never the
 * stream). Buckets are cumulative within a message — `message_start` carries the input buckets,
 * each `message_delta` the running output total — so later values replace earlier ones per key.
 */
const createSseUsageParser = () => {
	const decoder = new TextDecoder()
	const merged: Record<string, unknown> = {}
	let model: string | undefined
	let remainder = ''
	const parseLine = (line: string) => {
		if (!line.startsWith('data:') || !line.includes('"usage"')) return
		let event: unknown
		try {
			event = JSON.parse(line.slice(5))
		} catch {
			return
		}
		if (typeof event !== 'object' || event === null) return
		// message_start nests usage/model under `message`; message_delta carries usage at top level
		const carrier = ((event as { message?: unknown }).message ?? event) as Record<string, unknown>
		if (typeof carrier.model === 'string') model = carrier.model
		const usage = carrier.usage
		if (typeof usage !== 'object' || usage === null) return
		for (const [key, value] of Object.entries(usage)) {
			if (typeof value === 'number') merged[key] = value
		}
	}
	return {
		push: (chunk: Uint8Array) => {
			remainder += decoder.decode(chunk, { stream: true })
			const lines = remainder.split('\n')
			remainder = lines.pop() ?? ''
			for (const line of lines) parseLine(line)
		},
		result: (): ParsedUsage => {
			parseLine(remainder + decoder.decode())
			remainder = ''
			return { usage: usageFrom(merged), model }
		},
	}
}

const handleRequest = async (
	req: IncomingMessage,
	res: ServerResponse,
	{
		apiKey,
		upstream,
		fetchImpl,
		onUsage,
	}: Required<Omit<StartAnthropicForwardProxyOptions, 'port' | 'onUsage'>> &
		Pick<StartAnthropicForwardProxyOptions, 'onUsage'>
) => {
	let requestBytes = 0
	let responseBytes = 0
	/** Metering must never take the relay down — the sample is best effort, the budget's floor */
	const report = (sample: ProxyUsageSample) => {
		try {
			onUsage?.(sample)
		} catch {
			// swallowed: a metering-sink bug must not break model access
		}
	}
	const zeroUsage = (): TokenUsage => ({ inputTokens: 0, outputTokens: 0 })
	try {
		const body = await readBody(req)
		requestBytes = body?.length ?? 0
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
		const contentType = upstreamResponse.headers.get('content-type') ?? ''
		const sse = contentType.includes('text/event-stream') ? createSseUsageParser() : undefined
		const jsonChunks: Uint8Array[] = []
		if (upstreamResponse.body) {
			for await (const chunk of upstreamResponse.body) {
				responseBytes += chunk.length
				if (sse) sse.push(chunk)
				else if (responseBytes <= jsonParseCapBytes) jsonChunks.push(chunk)
				res.write(chunk)
			}
		}
		res.end()
		const parsed = sse
			? sse.result()
			: responseBytes <= jsonParseCapBytes
				? parseJsonUsage(Buffer.concat(jsonChunks))
				: {}
		const ok = upstreamResponse.status >= 200 && upstreamResponse.status < 300
		// A 2xx with no parseable usage still spent SOMETHING upstream — estimate from bytes so a
		// caller can never make free calls by steering the response shape. Non-2xx bills nothing
		// upstream, so it reports zero usage (the sample still records the request/bytes).
		const estimated = ok && !parsed.usage
		const usage =
			parsed.usage ??
			(estimated
				? {
						inputTokens: Math.ceil((requestBytes + responseBytes) / estimateBytesPerToken),
						outputTokens: 0,
					}
				: zeroUsage())
		report({
			usage,
			model: parsed.model,
			estimated,
			requestBytes,
			responseBytes,
			status: upstreamResponse.status,
		})
	} catch (error) {
		report({ usage: zeroUsage(), estimated: false, requestBytes, responseBytes, status: 502 })
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
	onUsage,
	upstream = 'https://api.anthropic.com',
	fetchImpl = fetch,
	port = 0,
}: StartAnthropicForwardProxyOptions): Promise<AnthropicForwardProxy> => {
	const server: Server = createServer((req, res) => {
		void handleRequest(req, res, { apiKey, upstream, fetchImpl, onUsage })
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
