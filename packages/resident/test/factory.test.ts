import { createFactoryReporter } from '#/factory.ts'
import { buildUsageRecord, emptyDayUsage } from '#/metering.ts'

const record = buildUsageRecord({
	installationId: 'acme',
	repository: 'acme/shop',
	day: '2026-09-03',
	usage: emptyDayUsage(),
	monthlyCap: { tokens: 1, usedTokens: 0 },
	now: () => 0,
})

const response = (status: number, body: unknown = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('factory reporter', () => {
	it('POSTs the record with the installation bearer and retries a 5xx', async () => {
		// Arrange
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(503, { message: 'down' }))
			.mockResolvedValueOnce(response(200, { id: 'acme/2026-09-03', stored: true }))
		const reporter = createFactoryReporter({
			apiUrl: 'https://api.example.com/',
			token: 'inst-token',
			fetch: fetchImpl,
			retryDelayMs: 1,
		})

		// Act
		const result = await reporter.report(record)

		// Assert
		expect(result).toEqual({ id: 'acme/2026-09-03', stored: true })
		expect(fetchImpl).toHaveBeenCalledTimes(2)
		const [url, init] = fetchImpl.mock.calls[0]!
		expect(url).toBe('https://api.example.com/internal/resident/usage')
		expect(init).toMatchObject({
			method: 'POST',
			headers: { authorization: 'Bearer inst-token', 'content-type': 'application/json' },
		})
		expect(JSON.parse(init!.body as string)).toEqual(record)
	})

	it('Does not retry a 4xx', async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(401, { message: 'no' }))
		const reporter = createFactoryReporter({
			apiUrl: 'https://api.example.com',
			token: 'bad',
			fetch: fetchImpl,
			retryDelayMs: 1,
		})

		await expect(reporter.report(record)).rejects.toThrow('→ 401')
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})
})
