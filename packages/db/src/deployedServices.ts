import type { DeployedService, DeployedServiceConfig } from '@mf/models'
import type { Db } from './index.ts'
import type { DeployedServicesRepository, NewDeployedService } from './repositories.ts'

// MARK: Row mapping

type DeployedServiceRow = {
	id: string
	order_id: string
	job_id: string | null
	service_name: string
	service_arn: string | null
	customer_tag: string
	image: string | null
	config: DeployedServiceConfig | null
	created_at: Date
	deleted_at: Date | null
}

export const toDeployedService = (row: DeployedServiceRow): DeployedService => ({
	id: row.id,
	orderId: row.order_id,
	jobId: row.job_id ?? undefined,
	serviceName: row.service_name,
	serviceArn: row.service_arn ?? undefined,
	customerTag: row.customer_tag,
	image: row.image ?? undefined,
	config: row.config ?? undefined,
	createdAt: row.created_at.toISOString(),
	deletedAt: row.deleted_at?.toISOString(),
})

// MARK: Queries

/**
 * Records the service, upserting onto the live row of the same `(order_id, service_name)` (a
 * redelivery) via the `deployed_services_order_service_idx` partial unique index. A previously
 * torn-down name is not matched by that index, so it is re-recorded as a fresh live row.
 */
export const recordDeployedService = async (
	db: Db,
	service: NewDeployedService
): Promise<DeployedService> => {
	const { sql } = db
	const [row] = await sql<DeployedServiceRow[]>`
		insert into deployed_services (order_id, job_id, service_name, service_arn, customer_tag, image, config)
		values (
			${service.orderId}, ${service.jobId ?? null}, ${service.serviceName},
			${service.serviceArn ?? null}, ${service.customerTag}, ${service.image ?? null},
			${service.config ? sql.json(service.config as never) : null}
		)
		on conflict (order_id, service_name) where deleted_at is null do update set
			job_id = excluded.job_id,
			service_arn = excluded.service_arn,
			customer_tag = excluded.customer_tag,
			image = excluded.image,
			config = excluded.config
		returning *`
	return toDeployedService(row!)
}

export const listDeployedServicesForOrder = async (
	db: Db,
	orderId: string
): Promise<DeployedService[]> => {
	const rows = await db.sql<DeployedServiceRow[]>`
		select * from deployed_services
		where order_id = ${orderId} and deleted_at is null
		order by created_at asc`
	return rows.map(toDeployedService)
}

export const setDeployedServiceArn = async (
	db: Db,
	id: string,
	serviceArn: string | null
): Promise<DeployedService | undefined> => {
	const [row] = await db.sql<DeployedServiceRow[]>`
		update deployed_services set service_arn = ${serviceArn}
		where id = ${id} and deleted_at is null
		returning *`
	return row && toDeployedService(row)
}

export const markDeployedServicesSuspended = async (db: Db, orderId: string): Promise<number> => {
	const rows = await db.sql<{ id: string }[]>`
		update deployed_services set service_arn = null
		where order_id = ${orderId} and deleted_at is null
		returning id`
	return rows.length
}

export const markDeployedServicesTornDown = async (db: Db, orderId: string): Promise<number> => {
	const rows = await db.sql<{ id: string }[]>`
		update deployed_services set deleted_at = now()
		where order_id = ${orderId} and deleted_at is null
		returning id`
	return rows.length
}

export const createDeployedServicesRepository = (db: Db): DeployedServicesRepository => ({
	record: service => recordDeployedService(db, service),
	listForOrder: orderId => listDeployedServicesForOrder(db, orderId),
	setArn: (id, serviceArn) => setDeployedServiceArn(db, id, serviceArn),
	markSuspended: orderId => markDeployedServicesSuspended(db, orderId),
	markTornDown: orderId => markDeployedServicesTornDown(db, orderId),
})
