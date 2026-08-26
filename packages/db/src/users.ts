import { isUuid } from './jobs.ts'

import type { Org, User } from '@mf/models'
import type { Db } from './index.ts'
import type { GithubIdentity, NewOrg, NewUser, UsersRepository } from './repositories.ts'

// MARK: Row mapping

type UserRow = {
	id: string
	org_id: string
	email: string
	name: string | null
	role: User['role']
	github_id: string | null
	github_login: string | null
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
	githubId: row.github_id ?? undefined,
	githubLogin: row.github_login ?? undefined,
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

export const findUserByGithubId = async (db: Db, githubId: string): Promise<User | undefined> => {
	const [row] = await db.sql<UserRow[]>`select * from users where github_id = ${githubId}`
	return row && toUser(row)
}

export const insertUser = async (db: Db, user: NewUser): Promise<User> => {
	const [row] = await db.sql<UserRow[]>`
		insert into users (org_id, email, name, role, github_id, github_login)
		values (
			${user.orgId}, ${user.email}, ${user.name ?? null}, ${user.role},
			${user.githubId ?? null}, ${user.githubLogin ?? null}
		)
		returning *`
	return toUser(row!)
}

export const linkGithub = async (
	db: Db,
	id: string,
	identity: GithubIdentity
): Promise<User | undefined> => {
	if (!isUuid(id)) return undefined
	const [row] = await db.sql<UserRow[]>`
		update users set
			github_id = ${identity.githubId},
			github_login = ${identity.githubLogin},
			name = coalesce(name, ${identity.name ?? null})
		where id = ${id}
		returning *`
	return row && toUser(row)
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
			insert into users (org_id, email, name, role, github_id, github_login)
			values (
				${orgRow!.id}, ${user.email}, ${user.name ?? null}, ${user.role},
				${user.githubId ?? null}, ${user.githubLogin ?? null}
			)
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
	findByGithubId: githubId => findUserByGithubId(db, githubId),
	insert: user => insertUser(db, user),
	linkGithub: (id, identity) => linkGithub(db, id, identity),
	insertWithOrg: (user, org) => insertUserWithOrg(db, user, org),
	getOrg: id => getOrg(db, id),
	insertOrg: org => insertOrg(db, org),
	listOrgs: () => listOrgs(db),
})
