import { appApi } from '#/app/api.ts'

import type { AuthMutation, TokenPair } from '@mf/models'

export const authApiSlice = appApi.injectEndpoints({
	endpoints: build => ({
		requestMagicLink: build.mutation<void, AuthMutation['RequestMagicLink']>({
			query: body => ({ url: '/auth/magic-link', method: 'POST', body }),
		}),
		verifyMagicLink: build.mutation<TokenPair, AuthMutation['VerifyMagicLink']>({
			query: body => ({ url: '/auth/verify', method: 'POST', body }),
		}),
		logout: build.mutation<void, AuthMutation['Logout']>({
			query: body => ({ url: '/auth/logout', method: 'POST', body }),
		}),
	}),
})

export const { useRequestMagicLinkMutation, useVerifyMagicLinkMutation, useLogoutMutation } =
	authApiSlice
