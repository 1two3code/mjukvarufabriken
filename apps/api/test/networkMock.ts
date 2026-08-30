import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

import type { DefaultBodyType, HttpRequestHandler, StrictRequest } from 'msw'
import type { SetupServer } from 'msw/node'

type MockRequestResponse = Record<string, unknown> | Record<string, unknown>[] | (() => void)

type SequentialResponse = {
	statusCode: number | null
	response?: MockRequestResponse
	headers?: Record<string, string>
}

interface MockSpy {
	callCount: number
	requests: StrictRequest<DefaultBodyType>[]
	assert: (predicate: (req: StrictRequest<DefaultBodyType>) => boolean) => boolean
	called: (n?: number) => boolean
	reset: () => void
}

type MockRequestReply = (
	statusCode: number | null,
	response?: MockRequestResponse,
	options?: { headers?: Record<string, string> }
) => {
	reply: MockRequestReply
	spy: MockSpy
}

type MockRequestValidity = {
	/**
	 * Validates that the request contains the specified headers
	 */
	headers?: string[]
	/**
	 * Validates that the request contains the specified search params
	 */
	searchParams?: string[]
	/**
	 * Validates that the request contains the specified body
	 */
	body?: object
}

type MockEndpoint = (
	url: string,
	validity?: MockRequestValidity
) => {
	reply: MockRequestReply
}

export type NetworkMock = {
	/**
	 * Registers a POST endpoint with the specified URL and response for mocking purposes
	 */
	post: MockEndpoint
	/**
	 * Registers a GET endpoint with the specified URL and response for mocking purposes
	 */
	get: MockEndpoint
	/**
	 * Registers a PUT endpoint with the specified URL and response for mocking purposes
	 */
	put: MockEndpoint
	/**
	 * Registers a PATCH endpoint with the specified URL and response for mocking purposes
	 */
	patch: MockEndpoint
	/**
	 * Reset all mock spies, clearing their call counts and request history
	 */
	reset: () => void
}

const isRequestValid = (request: Request, validity: MockRequestValidity) => {
	if (
		validity.headers?.some(header => !request.headers.get(header)) ||
		validity.searchParams?.some(param => !new URL(request.url).searchParams.get(param))
	) {
		return false
	}

	return true
}

export const createNetworkMock = (): {
	/**
	 * Network server instance for mocking purposes
	 */
	networkServer: SetupServer
	/**
	 * Mocking utility for registering endpoints
	 */
	networkMock: NetworkMock
} => {
	const server = setupServer()
	const mocks = new Map<string, MockSpy>()

	const reset = () => {
		mocks.forEach(mock => {
			mock.reset()
		})
	}

	const mockRequest = (
		handler: HttpRequestHandler,
		url: string,
		validity?: MockRequestValidity
	) => {
		const mockKey = `${handler.toString()}:${url}`

		if (!mocks.has(mockKey)) {
			mocks.set(mockKey, {
				callCount: 0,
				requests: [],
				assert: (predicate: (req: StrictRequest<DefaultBodyType>) => boolean) =>
					mocks.get(mockKey)!.requests.some(predicate),
				called: (n = 1) => mocks.get(mockKey)!.callCount === n,
				reset: () => {
					const mock = mocks.get(mockKey)!
					mock.callCount = 0
					mock.requests = []
				},
			})
		}

		const mockSpy = mocks.get(mockKey)!
		const sequentialResponses: SequentialResponse[] = []

		const createReplyFunction = (): MockRequestReply => {
			const replyFn = (
				statusCode: number | null,
				response?: MockRequestResponse,
				options?: { headers?: Record<string, string> }
			) => {
				sequentialResponses.push({ statusCode, response, headers: options?.headers })

				server.use(
					handler(url, async ({ request }) => {
						mockSpy.callCount++
						mockSpy.requests.push(request as StrictRequest<DefaultBodyType>)

						if (validity && !isRequestValid(request, validity)) {
							return new HttpResponse('Invalid request', { status: 400 })
						}

						const responseIdx = Math.min(mockSpy.callCount - 1, sequentialResponses.length - 1)
						const currentResponse = sequentialResponses[responseIdx]

						if (!currentResponse.response) {
							return new HttpResponse(null, {
								status: currentResponse.statusCode ?? 200,
								headers: currentResponse.headers,
							})
						}
						return HttpResponse.json(currentResponse.response, {
							status: currentResponse.statusCode ?? 200,
							headers: currentResponse.headers,
						})
					})
				)

				return {
					reply: replyFn,
					spy: mockSpy,
				}
			}

			return replyFn
		}

		return {
			reply: createReplyFunction(),
		}
	}

	return {
		networkServer: server,
		networkMock: {
			get: (url, validity) => mockRequest(http.get, url, validity),
			post: (url, validity) => mockRequest(http.post, url, validity),
			put: (url, validity) => mockRequest(http.put, url, validity),
			patch: (url, validity) => mockRequest(http.patch, url, validity),
			reset,
		},
	}
}
