# @mf/db

Postgres layer skeleton. `createDb(connectionString)` returns a `Db` placeholder; `migrations/` holds plain SQL applied in file order (`0001_init.sql`: orgs, users, orders, jobs, job_events).

Zero runtime dependencies for now. A driver and a migration runner are added when the api's in-memory `store` plugin is swapped for this layer (M6), backed by RDS from the `resources-<env>` stack.
