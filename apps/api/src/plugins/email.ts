import fp from 'fastify-plugin'
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2'

import type { FastifyPluginAsync } from 'fastify'

export type OutgoingEmail = {
	to: string
	subject: string
	text: string
	html?: string
}

declare module 'fastify' {
	interface FastifyInstance {
		/**
		 * Outgoing email. Transport is chosen by `secrets.emailTransport`: `ses` sends through
		 * SES v2, `log` writes the message to the log at info level (local/dev without SES
		 * production access — the magic link is copied from the api log).
		 */
		email: {
			send: (email: OutgoingEmail) => Promise<void>
		}
	}
}

const plugin: FastifyPluginAsync = async app => {
	const { emailTransport, emailFrom } = app.secrets

	if (emailTransport === 'log') {
		app.decorate('email', {
			send: async email => {
				app.log.info({ email }, `Email to ${email.to} (log transport, not sent)`)
			},
		})
		return
	}

	const client = new SESv2Client({})
	app.addHook('onClose', () => client.destroy())

	app.decorate('email', {
		send: async ({ to, subject, text, html }) => {
			await client.send(
				new SendEmailCommand({
					FromEmailAddress: emailFrom,
					Destination: { ToAddresses: [to] },
					Content: {
						Simple: {
							Subject: { Data: subject, Charset: 'UTF-8' },
							Body: {
								Text: { Data: text, Charset: 'UTF-8' },
								...(html && { Html: { Data: html, Charset: 'UTF-8' } }),
							},
						},
					},
				})
			)
		},
	})
}

export default fp(plugin, { name: '#internal/email', dependencies: ['#internal/secrets'] })
