import { appApi } from '#/app/api.ts'

export type ContactMessage = {
	name: string
	email: string
	company?: string
	message: string
}

export const contactApiSlice = appApi.injectEndpoints({
	endpoints: build => ({
		sendContactMessage: build.mutation<Record<string, never>, ContactMessage>({
			query: body => ({ url: '/contact', method: 'POST', body }),
		}),
	}),
})

export const { useSendContactMessageMutation } = contactApiSlice
