/** First line of a gate's summary — what the collapsed row on the order page shows */
export const gateHeadline = (summary: string) =>
	summary
		.split('\n')
		.find(line => line.trim())
		?.trim() ?? ''

/** `details` is free-form per gate: scalars inline, anything else pretty-printed */
export const formatGateDetail = (value: unknown) =>
	typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
		? String(value)
		: JSON.stringify(value, null, 2)
