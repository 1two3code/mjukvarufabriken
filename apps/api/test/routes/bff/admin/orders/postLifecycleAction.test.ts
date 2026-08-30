import postLifecycleAction from '#/routes/bff/admin/orders/postLifecycleAction.ts'
import { EntityInvalid, EntityNotFound } from '#/lib/entityError.ts'

import type { FastifyInstance } from 'fastify'

describe('POST /bff/admin/orders/:orderId/lifecycle route', () => {
	let app: FastifyInstance

	const url = '/bff/admin/orders/order-1/lifecycle'

	beforeEach(async () => {
		app = await createTestApp()
		app.register(postLifecycleAction)
	})

	it('Runs a dry-run action by default and returns the deprovision summary', async () => {
		// Act
		const response = await app.inject({ method: 'POST', url, payload: { action: 'suspend' } })

		// Assert
		expect(response.statusCode).toBe(200)
		expect(app.accountService.runLifecycleAction).toHaveBeenCalledWith('order-1', 'suspend', {
			confirm: undefined,
		})
		const body = response.json()
		expect(body).toMatchObject({ action: 'suspend', dryRun: true, applied: false })
		expect(body.deprovision).toMatchObject({ mode: 'suspend', dryRun: true })
	})

	it('Passes confirm through for a real teardown', async () => {
		const response = await app.inject({
			method: 'POST',
			url,
			payload: { action: 'teardown', confirm: true },
		})

		expect(response.statusCode).toBe(200)
		expect(app.accountService.runLifecycleAction).toHaveBeenCalledWith('order-1', 'teardown', {
			confirm: true,
		})
		expect(response.json()).toMatchObject({ action: 'teardown', dryRun: false, applied: true })
	})

	it('Rejects an unknown action with 400', async () => {
		const response = await app.inject({ method: 'POST', url, payload: { action: 'nuke' } })

		expect(response.statusCode).toBe(400)
		expect(app.accountService.runLifecycleAction).not.toHaveBeenCalled()
	})

	it('Maps EntityNotFound to 404', async () => {
		vi.spyOn(app.accountService, 'runLifecycleAction').mockRejectedValue(
			new EntityNotFound('order', 'order-1')
		)

		const response = await app.inject({ method: 'POST', url, payload: { action: 'suspend' } })

		expect(response.statusCode).toBe(404)
	})

	it('Maps a disallowed transition (EntityInvalid) to 409', async () => {
		vi.spyOn(app.accountService, 'runLifecycleAction').mockRejectedValue(
			new EntityInvalid('lifecycle', 'order-1')
		)

		const response = await app.inject({
			method: 'POST',
			url,
			payload: { action: 'resume', confirm: true },
		})

		expect(response.statusCode).toBe(409)
	})
})
