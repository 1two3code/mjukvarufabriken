import type { ResidentUsageRecord, ResidentUsageResponse } from '@mf/models'

/** Where a day's usage record goes besides the bucket: the factory api, for billing */
export type UsageReporter = {
	report: (record: ResidentUsageRecord) => Promise<ResidentUsageResponse | undefined>
}

export type FactoryReporterOptions = {
	/** `FACTORY_API_URL`, e.g. `https://api.mjukvaruhuset.se` */
	apiUrl: string
	/** `FACTORY_TOKEN` — the installation's bearer token */
	token: string
	fetch?: typeof fetch
	retries?: number
	retryDelayMs?: number
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * `POST /internal/resident/usage` with retries on transport errors and 5xx; a 4xx is final and
 * throws (the record stays in the bucket either way, and the next flush retries the day).
 */
export const createFactoryReporter = ({
	apiUrl,
	token,
	fetch: fetchImpl = fetch,
	retries = 3,
	retryDelayMs = 500,
}: FactoryReporterOptions): UsageReporter => {
	const url = `${apiUrl.replace(/\/+$/, '')}/internal/resident/usage`
	return {
		report: async record => {
			let lastError: Error = new Error('no attempt made')
			for (let attempt = 0; attempt <= retries; attempt += 1) {
				if (attempt > 0) await sleep(retryDelayMs * 2 ** (attempt - 1))
				try {
					const response = await fetchImpl(url, {
						method: 'POST',
						headers: {
							authorization: `Bearer ${token}`,
							'content-type': 'application/json',
							accept: 'application/json',
						},
						body: JSON.stringify(record),
					})
					if (response.ok) return (await response.json()) as ResidentUsageResponse
					const text = await response.text().catch(() => '')
					lastError = new Error(`POST /internal/resident/usage → ${response.status} ${text}`)
					if (response.status < 500) throw lastError
				} catch (error) {
					lastError = error as Error
					if (/→ 4\d\d/.test(lastError.message)) throw lastError
				}
			}
			throw lastError
		},
	}
}

/** No factory configured (`FACTORY_API_URL` unset): records only go to the bucket */
export const createNoopUsageReporter = (): UsageReporter => ({ report: async () => undefined })

export type FakeUsageReporter = UsageReporter & { records: ResidentUsageRecord[]; fail?: boolean }

export const createFakeUsageReporter = (): FakeUsageReporter => {
	const fake: FakeUsageReporter = {
		records: [],
		report: async record => {
			if (fake.fail) throw new Error('fake: factory unreachable')
			fake.records.push(record)
			return { id: `${record.installationId}/${record.day}`, stored: true }
		},
	}
	return fake
}
