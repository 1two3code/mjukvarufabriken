export type ApiError = {
	requestId: string
	status: number
	message: string
	timestamp: string
	path: string

	/**
	 * Code is used to identify the error in the frontend
	 */
	code?: string

	/**
	 * Variables for i18n interpolation in the frontend
	 */
	variables?: Record<string, string | number>
}
