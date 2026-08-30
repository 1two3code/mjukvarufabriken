import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2'

// No bundler, no local dependencies: the Node 24 Lambda runtime ships the AWS SDK v3 clients
// already, so this whole folder is zipped as-is (infra/mail/lib/mail-stack.ts, Code.fromAsset).

const s3 = new S3Client({})
const ses = new SESv2Client({})

const headerBoundary = /\r?\n\r?\n/

const readStream = async stream => {
	const chunks = []
	for await (const chunk of stream) chunks.push(chunk)
	return Buffer.concat(chunks)
}

/** Pulls the display name + address out of a raw `From:` value, e.g. `"A B" <a@b.c>`. */
const parseFrom = headerValue => {
	const match = headerValue.match(/^(.*)<([^>]+)>\s*$/)
	if (!match) return { name: '', address: headerValue.trim() }
	return { name: match[1].trim().replace(/^"|"$/g, ''), address: match[2].trim() }
}

/**
 * Rewrites just the header block of a raw MIME message so it can be re-sent from an identity we
 * own: replace `From`/`Reply-To` and drop `Return-Path`/`DKIM-Signature` (both stale the moment we
 * touch the message), keep every other header and the entire body byte-for-byte. Folded header
 * continuation lines (starting with whitespace) stay attached to their parent line.
 */
const rewriteHeaders = (raw, fromAddress) => {
	const boundaryMatch = raw.toString('latin1').match(headerBoundary)
	if (!boundaryMatch) throw new Error('no header/body boundary found in raw message')
	const boundaryIndex = boundaryMatch.index + boundaryMatch[0].length
	const headerText = raw.subarray(0, boundaryIndex).toString('latin1')
	const body = raw.subarray(boundaryIndex)

	const originalFromLine = headerText.match(/^From:.*(?:\r?\n[ \t].*)*/im)?.[0] ?? ''
	const originalFrom = parseFrom(originalFromLine.replace(/^From:\s*/i, ''))

	const kept = headerText
		.split(/\r?\n(?![ \t])/)
		.filter(line => !/^(From|Reply-To|Return-Path|DKIM-Signature):/i.test(line))
		.join('\r\n')
		.replace(/\r?\n$/, '')

	const displayName = originalFrom.name || originalFrom.address || 'unknown sender'
	const replyTo = originalFrom.address ? `Reply-To: ${originalFrom.address}\r\n` : ''
	const newHeaders = `${kept}\r\nFrom: "${displayName} (via Mjukvaruhuset)" <${fromAddress}>\r\n${replyTo}\r\n`

	return Buffer.concat([Buffer.from(newHeaders, 'latin1'), body])
}

export const handler = async event => {
	const forwardTo = process.env.FORWARD_TO
	const fromAddress = process.env.FROM_ADDRESS
	const bucket = process.env.BUCKET_NAME
	if (!forwardTo || !fromAddress || !bucket) {
		throw new Error('missing FORWARD_TO/FROM_ADDRESS/BUCKET_NAME env vars')
	}

	for (const record of event.Records ?? []) {
		const messageId = record.ses?.mail?.messageId
		if (!messageId) continue

		const object = await s3.send(
			new GetObjectCommand({ Bucket: bucket, Key: `inbound/${messageId}` })
		)
		const raw = await readStream(object.Body)
		const forwarded = rewriteHeaders(raw, fromAddress)

		await ses.send(
			new SendEmailCommand({
				FromEmailAddress: fromAddress,
				Destination: { ToAddresses: [forwardTo] },
				Content: { Raw: { Data: forwarded } },
			})
		)
	}
}
