type ErrorDetails = {
	entityName: string
	id?: string
	type: 'notFound' | 'invalid'
}

const createMessage = ({ entityName, id, type }: ErrorDetails) => {
	const entityId = id ? `${entityName} (${id})` : entityName
	if (type === 'notFound') return `${entityId} not found`
	return `${entityId} is invalid`
}

export class EntityError extends Error {
	type: ErrorDetails['type']
	entityName: ErrorDetails['entityName']

	constructor(details: ErrorDetails) {
		super(createMessage(details))
		this.type = details.type
		this.entityName = details.entityName
	}
}

export class EntityNotFound extends EntityError {
	constructor(entityName: string, id?: string) {
		super({ entityName, id, type: 'notFound' })
	}
}

export class EntityInvalid extends EntityError {
	constructor(entityName: string, id?: string) {
		super({ entityName, id, type: 'invalid' })
	}
}
