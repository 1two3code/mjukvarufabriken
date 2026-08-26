import { isUuid } from './jobs.ts'

import type { Org, User } from '@mf/models'
import type { Db } from './index.ts'
import type { NewOrg, NewUser, UsersRepository } from './repositories.ts'

// MARK: Row mapping

type UserRow = {
	id: string
	org_id: string
	email: string
	name: string | null
	role: User['role']
	created_at: Date
}

type OrgRow = {
	id: string
	name: string
	org_number: string | null
	created_at: Date
}

export const toUser = (row: UserRow): User => ({
	id: row.id,
	email: row.email,
	name: row.name ?? undefined,
	role: row.role,
	orgId: row.org_id,
	createdAt: row.created_at.toISOString(),
})

export const toOrg = (row: OrgRow): Org => ({
	id: row.id,
	name: row.name,
	createdAt: row.created_at.toISOString(),
})

// MARK: Repository

export const getUser = async (db: Db, id: string): Promise<User | undefined> => {
	if (!isUuid(id)) return undefined
	const [row] = await db.sql<UserRow[]>`select * from users where id = ${id}`
	return row && toUser(row)
}

export const findUserByEmail = async (db: Db, email: string): Promise<User | undefined> => {
	const [row] = await db.sql<UserRow[]>`select * from users where email = ${email}`
	return row && toUser(row)
}

export const insertUser = async (db: Db, user: NewUser): Promise<User> => {
	const [row] = await db.sql<UserRow[]>`
		insert into users (org_id, email, name, role)
		values (${user.orgId}, ${user.email}, ${user.name ?? null}, ${user.role})
		returning *`
	return toUser(row!)
}

/** Org + first user in one transaction: a `users.email` unique violation rolls the org back */
export const insertUserWithOrg = async (
	db: Db,
	user: Omit<NewUser, 'orgId'>,
	org: NewOrg
): Promise<User> => {
	const [row] = await db.sql.begin(async tx => {
		const [orgRow] = await tx<OrgRow[]>`insert into orgs (name) values (${org.name}) returning *`
		return tx<UserRow[]>`
			insert into users (org_id, email, name, role)
			values (${orgRow!.id}, ${user.email}, ${user.name ?? null}, ${user.role})
			returning *`
	})
	return toUser(row!)
}

export const getOrg = async (db: Db, id: string): Promise<Org | undefined> => {
	if (!isUuid(id)) return undefined
	const [row] = await db.sql<OrgRow[]>`select * from orgs where id = ${id}`
	return row && toOrg(row)
}

export const insertOrg = async (db: Db, org: NewOrg): Promise<Org> => {
	const [row] = await db.sql<OrgRow[]>`insert into orgs (name) values (${org.name}) returning *`
	return toOrg(row!)
}

export const listOrgs = async (db: Db): Promise<Org[]> => {
	const rows = await db.sql<OrgRow[]>`select * from orgs order by created_at desc limit 500`
	return rows.map(toOrg)
}

export const createUsersRepository = (db: Db): UsersRepository => ({
	get: id => getUser(db, id),
	findByEmail: email => findUserByEmail(db, email),
	insert: user => insertUser(db, user),
	insertWithOrg: (user, org) => insertUserWithOrg(db, user, org),
	getOrg: id => getOrg(db, id),
	insertOrg: org => insertOrg(db, org),
	listOrgs: () => listOrgs(db),
})
