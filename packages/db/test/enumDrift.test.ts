import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { jobStatus, lifecycleStates, orderExportStatus, orderKind, orderStatus } from '@mf/models'

import { migrationsDir } from '#/index.ts'

/**
 * Enum drift guard (audit P0-2). Every `text ... check (col in (...))` column in the schema mirrors
 * a `as const` tuple in @mf/models, and nothing until now made the two agree: `orders_status_check`
 * was last stated in 0004 with eight values while `orderStatus` grew a ninth (`awaiting_approval`)
 * in 0012, so the shipped approve-before-deliver flow wrote a value Postgres refused (23514).
 *
 * The `migrations.test.ts` suite catches this class of bug only against a real Postgres, and only
 * for the transitions a behavioural test happens to walk. This one is static — it reads the SQL
 * files, takes the LAST definition of each CHECK and asserts set-equality with the tuple in code —
 * so it needs no infrastructure and covers every value, not just the exercised ones.
 *
 * Add a pair here whenever a new enum column lands.
 */

// MARK: A tiny SQL reader — enough for `check (<column> in ('a', 'b'))`, nothing more

type CheckDefinition = { table: string; column: string; values: string[] }

/** `create table X (` / `alter table X ...` — the table a statement's CHECKs belong to */
const tableOfStatement = /(?:create|alter)\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_]+)/i

/** `check (col in ('a', 'b', …))`. Value lists here never contain parentheses. */
const checkConstraint = /check\s*\(\s*([a-z_]+)\s+in\s*\(([^)]*)\)\s*\)/gi

const quotedValues = /'([^']*)'/g

/**
 * Every enum CHECK in the migrations, in file-then-statement order. Line comments are stripped
 * first (0020's header talks about the constraint it re-states); statements split on `;`, which is
 * safe because no migration uses dollar-quoting or a semicolon inside a literal.
 */
const parseEnumChecks = (sql: string): CheckDefinition[] =>
	sql
		.replace(/--[^\n]*/g, '')
		.split(';')
		.flatMap(statement => {
			const table = tableOfStatement.exec(statement)?.[1]
			if (!table) return []
			return [...statement.matchAll(checkConstraint)].map(([, column, list]) => ({
				table,
				column: column as string,
				values: [...(list as string).matchAll(quotedValues)].map(([, value]) => value as string),
			}))
		})

const migrationChecks = (): CheckDefinition[] =>
	readdirSync(migrationsDir)
		.filter(file => file.endsWith('.sql'))
		.sort()
		.flatMap(file => parseEnumChecks(readFileSync(join(migrationsDir, file), 'utf8')))

/**
 * The values a column is constrained to once every migration has been applied: a later
 * `add constraint`/`add column` restates the CHECK, so the last definition wins.
 */
const effectiveValues = (checks: CheckDefinition[], table: string, column: string) =>
	checks.filter(check => check.table === table && check.column === column).at(-1)?.values

// MARK: Tests

describe('schema enums match @mf/models', () => {
	const checks = migrationChecks()

	it.each([
		{ table: 'orders', column: 'status', tuple: 'orderStatus', values: orderStatus },
		{ table: 'jobs', column: 'status', tuple: 'jobStatus', values: jobStatus },
		{ table: 'orders', column: 'lifecycle', tuple: 'lifecycleStates', values: lifecycleStates },
		{ table: 'orders', column: 'kind', tuple: 'orderKind', values: orderKind },
		{
			table: 'order_exports',
			column: 'status',
			tuple: 'orderExportStatus',
			values: orderExportStatus,
		},
	])('column $column on $table is exactly $tuple', ({ table, column, values }) => {
		const sqlValues = effectiveValues(checks, table, column)

		expect(sqlValues, `no CHECK found for ${table}.${column}`).toBeDefined()
		expect([...(sqlValues as string[])].sort()).toEqual([...values].sort())
	})

	it('reads the CHECK definitions it claims to (guards the parser itself)', () => {
		// A value list the parser must find, and one it must have superseded: without the last-wins
		// rule `orders.status` would still read as 0004's eight-value list.
		expect(effectiveValues(checks, 'payments', 'kind')).toEqual(['deposit', 'balance'])
		expect(effectiveValues(checks, 'orders', 'status')).toContain('awaiting_approval')
		expect(effectiveValues(checks, 'users', 'role')).toEqual(['admin', 'user'])
	})
})
