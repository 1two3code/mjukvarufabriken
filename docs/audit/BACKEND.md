# Backend + data layer review — `apps/api`, `packages/db`, `packages/models`

Worktree: `/home/wsl/dev/mjukvarufabriken/.claude/worktrees/deep-review` (read-only; no tracked
file modified). Scope: 19 migrations, 14 db repository modules (3 287 LOC), 13 API services
(2 328 LOC), 19 plugins (1 892 LOC), 46 route files (1 852 LOC), ~11 000 LOC of tests.

Known items deliberately **not** re-reported (already in `docs/DUE-DILIGENCE-2026-08-31.md` §5 and
`docs/backlog/hardening-2026-08-30/`): Gate C's "liveness sweep blind to `task_arn IS NULL`",
"`publicUrls` never updated", "merges trusted on git exit code", "guestbook 401 half-fix", Gate B's
egress fence / proxy spend metering / secret scanning / per-job STS tagging, Sentry DSNs unset, and
the Stripe live-mode / balance-on-delivery gap.

---

## Verdict

**The data layer is better designed than it is indexed, and better indexed than it is
constrained.** The engineering instincts on display are good — compare-and-set is used deliberately
(`transitionOrder`, `setLifecycle`, `markPaymentPaid`, `reserveResidentUsageReport`), idempotency is
real (`payment_events`, `job_events(job_id, seq)`, reserve-then-confirm billing), and the
`migrations.test.ts` header shows the team already learned once that memory-backed tests hide SQL
bugs. But that lesson was only applied to *migration application*, not to *behaviour*: every service
test runs against `createMemoryRepositories()`, so the schema and the code have quietly drifted.

The single most serious finding is **API-01**: `orders.status` still carries the 8-value CHECK
constraint written in migration 0004, and `awaiting_approval` — the whole point of the W7/W9
approve-before-deliver feature, present in `@mf/models`, written by `orderService.syncWithJob`, and
covered by green unit tests — was never added to it. On Postgres that flow raises `23514` on the
first delivered build of any order with the gate on. It passes in every test because the memory
backend has no CHECK constraints. That is the exact failure mode the repo's own `migrations.test.ts`
comment describes, recurring.

Close behind: **API-02**, `getDeliverables` reads only the first 500 job events while the
`bundle` event it needs is always the last one — so on a long job the customer's deliverables 404
forever; and **API-03**, `resident_usage` stores money as `double precision` and bills the summed
float, while every other money column in the schema is correctly `numeric`.

The liveness sweep, the rate-limit pruner, and the auth pruner all run **unindexed full-table
scans** on their hot tables (API-06 / D-1 / D-2 / D-3), the pool has **no statement, idle, or
connect timeout** (API-07), and every AWS SDK client in the process is constructed with `{}` — no
socket or connection timeout anywhere except Stripe and the GitHub fetch, which are both done
correctly and are the model to copy (API-08).

Nothing here is unfixable and most of it is a one-line migration or a one-option change. But the
combination — no FKs on `orders.org_id`/`jobs.order_id`, no CHECK on the state a feature writes, no
statement timeout, and a test suite that mocks the database away — means the schema currently
provides very little of the safety net the code assumes it has.

---

## Data layer

### Migration/CHECK drift (the schema does not know about states the code writes)

`0004_orders_users_auth.sql:21` rewrote the order status CHECK:

```sql
alter table orders add constraint orders_status_check check (
	status in (
		'drafting', 'ready', 'frozen',
		'deposit_paid', 'building', 'delivered', 'paid', 'cancelled'
	)
);
```

`0012_orders_approve_before_deliver.sql:8` then added the flag and *described* the new state in a
comment — "parks the order in `awaiting_approval` (a new order state)" — but only ran
`alter table orders add column approve_before_deliver boolean not null default false`. No migration
0012–0019 touches `orders_status_check`. `grep -rn "awaiting_approval" packages/db/migrations/`
returns only comment lines. See **API-01**.

### Dropped foreign keys that were never restored

`0002_jobs_task_arn.sql:5` and `0004_orders_users_auth.sql:11-12`:

```sql
alter table jobs drop constraint jobs_order_id_fkey;
alter table jobs alter column order_id type text using order_id::text;
...
alter table orders drop constraint orders_org_id_fkey;
alter table orders drop constraint orders_created_by_fkey;
```

Three referential constraints were dropped to widen uuid→text and **none was re-added**.
`jobs.order_id`, `orders.org_id` and `orders.created_by` are now unconstrained `text`, yet the code
dereferences all three as if they were guaranteed: `jobService.ts:249`
(`db.orders.getOrder(job.orderId)`), `jobService.ts:259` (`db.users.get(order.createdBy)`),
`accountService.ts:118` (`db.users.getOrg(orgId)`). A job whose order was deleted, or an order whose
org row never existed, is now a silent `undefined` instead of a constraint error. See **API-04**.
`users.org_id` is still `uuid references orgs(id)` while `orders.org_id` is `text` — the same logical
relation with two different types.

### Money as float (one table only)

`0009_resident_usage.sql:26-27`:

```sql
list_price_usd double precision not null,
billable_usd   double precision not null,
```

`summarizeResidentUsage` (`packages/db/src/resident.ts:199`) does `sum(u.billable_usd)`, and
`paymentService.ts` line ~330 turns that float into the amount actually metered:
`const totalUsdCents = usdCentsOf(summary.billableUsd)`. Compare `0018_job_usage_model_prices.sql:17`
(`cost_usd numeric(12, 4)`) and `0018:22-25` (`numeric(10, 4) ... check (input >= 0)`) — the rest of
the schema gets this right. See **API-03**.

### `CREATE INDEX` without `CONCURRENTLY` — and structurally unable to use it

Every `create index` in `packages/db/migrations/*.sql` (18 of them) is non-concurrent, and
`packages/db/src/migrate.ts:25` wraps the whole run in one transaction:

```ts
await sql.begin(async tx => {
	await tx`select pg_advisory_xact_lock(${migrationLockKey})`
```

`CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, so the current runner *cannot*
build a concurrent index even if a future migration asked for it. Today's tables are small, so this
is latent — but `job_events` and `rate_limits` are append-per-event tables that will be the first to
need an index added under load, and that index build will hold a `SHARE` lock blocking all writes
for its duration. Combined with `plugins/db.ts:169` running migrations at **API boot**, a slow index
build blocks the rollout. See **API-05**.

Also in `0002`/`0004`: `alter column ... type text using ...::text` is a **full table rewrite** under
`ACCESS EXCLUSIVE`. Harmless at today's row counts, but it is the pattern to not repeat.

Non-hazards worth recording so they are not re-flagged: `0011:16`
(`add column purpose text not null default 'email'`) and `0014:14` (`add column lifecycle ... not
null default 'active'`) are PG11+ fast defaults — no rewrite. `0018:33` seeds `model_prices` inside
the migration transaction, which is correct.

### Missing indexes

Every entry below was verified by reading the WHERE/ORDER BY of the query and checking every
`create index` in `packages/db/migrations/*.sql` for that table.

| Table | Columns (proposed index) | Query needing it | file:line |
|---|---|---|---|
| `jobs` | `(created_at) where status in ('queued','planning','building','verifying') and task_arn is not null` | `listStuckJobs` — `where status in (...) and task_arn is not null and created_at < $1 order by created_at asc limit 200`. Existing `jobs_order_idx`/`jobs_org_idx` lead with `order_id`/`org_id`; `jobs_one_active_per_order` is `(order_id)`-keyed. Nothing supports this predicate → **seq scan of `jobs` on every sweep tick** | [packages/db/src/jobs.ts:184](packages/db/src/jobs.ts#L184) |
| `rate_limits` | `(hit_at)` | `pruneRateLimits` — `delete from rate_limits where hit_at < $1`. Both existing indexes (`rate_limits_scope_key_idx`, `rate_limits_scope_idx`) lead with `scope`, so the hourly prune seq-scans the highest-churn table in the schema | [packages/db/src/rateLimits.ts:63](packages/db/src/rateLimits.ts#L63) |
| `magic_links` | `(expires_at)` | `pruneAuth` — `delete from magic_links where expires_at < now() - interval '7 days'`. Only `magic_links_email_idx(email, created_at desc)` exists | [packages/db/src/auth.ts:116](packages/db/src/auth.ts#L116) |
| `refresh_tokens` | `(expires_at)` + `(revoked_at)`, or rewrite as two `DELETE`s | `pruneAuth` — `where expires_at < now() or revoked_at < now() - interval '7 days'`. The `OR` across two columns cannot use a single index; only `refresh_tokens_user_idx(user_id)` exists | [packages/db/src/auth.ts:118](packages/db/src/auth.ts#L118) |
| `orders` | `(created_at desc)` | Admin (unfiltered) `listOrders`/`listOrderRecords` — `where true order by created_at desc limit 200`. `orders_org_idx(org_id, created_at desc)` only helps the org-filtered branch | [packages/db/src/orders.ts:108](packages/db/src/orders.ts#L108), [packages/db/src/orders.ts:192](packages/db/src/orders.ts#L192) |
| `orders` | `(org_id) where lifecycle = 'active' and status <> 'cancelled'` | `listActiveOrgIds` — `select distinct org_id ... where lifecycle='active' and status<>'cancelled' and org_id<>''`. Runs on every admin margin read; no index on `lifecycle` except the `suspended` partial one | [packages/db/src/orders.ts:351](packages/db/src/orders.ts#L351) |
| `jobs` | `(created_at desc)` | Admin `listJobs()` with no filter — `where true ... order by created_at desc limit 200` | [packages/db/src/jobs.ts:163](packages/db/src/jobs.ts#L163) |
| `job_events` | `(job_id, type)` | `countEvents` — `where job_id = $1 and type = $2`, called once **per `notify` event** in `notifyAdmins`. `job_events_job_idx(job_id, id)` gives the `job_id` prefix but re-reads every event row of the job to filter `type` | [packages/db/src/jobs.ts:270](packages/db/src/jobs.ts#L270) |
| `resident_usage` | `(month, day desc)` | `listResidentUsage` filtered by `month` only — `resident_usage_month_idx(month, installation_id)` matches the filter but not `order by day desc`, so 1 000 rows are sorted every call | [packages/db/src/resident.ts:183](packages/db/src/resident.ts#L183) |
| `resident_installations` | `(created_at desc)` | `listResidentInstallations` — `order by created_at desc limit 500` | [packages/db/src/resident.ts:109](packages/db/src/resident.ts#L109) |
| `orgs` | `(created_at desc)` | `listOrgs` — `select * from orgs order by created_at desc limit 500` | [packages/db/src/users.ts:124](packages/db/src/users.ts#L124) |

**Indexes that exist but are never used by any query in `packages/db/src`:**

| Index | Migration | Why it is dead |
|---|---|---|
| `refresh_tokens_user_idx (user_id)` | `0004:53` | No query filters or joins on `refresh_tokens.user_id`. Every access is by `token_hash` (the PK): `getRefreshToken`, `consumeRefreshToken` ([auth.ts:99](packages/db/src/auth.ts#L99)), `revokeRefreshToken` ([auth.ts:107](packages/db/src/auth.ts#L107)). There is no "revoke all sessions for a user" call. Drop it, or add the logout-everywhere query it implies |
| `model_prices_prefix_idx (model_prefix, effective_from desc)` | `0018:31` | `listModelPrices` orders by `effective_from desc, model_prefix asc` — wrong leading column, so it sorts anyway; `effectiveAt` reads the whole table and filters in JS (`pricesEffectiveAt`). Nothing seeks by `model_prefix` | [packages/db/src/modelPrices.ts:50](packages/db/src/modelPrices.ts#L50) |
| `pricing_tiers_key_idx (tier_key, effective_from desc)` | `0019:23` | Same shape, and the migration header states "Nothing reads this table yet". Expected to become live — noted for completeness, not to drop | [packages/db/src/pricingTiers.ts:35](packages/db/src/pricingTiers.ts#L35) |
| `jobs_org_idx (org_id, created_at desc)` | `0002:18` | Marginal: `listJobs` only ever passes `orgId` from `residentService`/admin paths that also pass `orderId`; the org-only branch is unreachable from any route today. Keep if org-scoped job listing is planned |

**Correctly indexed — verified, no action:** `jobs_report_token_hash_idx` ⇢ `getJobByReportToken`;
`job_events_job_idx(job_id, id)` ⇢ `listEvents` (`id > $2 order by id asc`);
`job_events_job_seq_idx` ⇢ `appendEventOnce`; `payments.session_id UNIQUE` ⇢ `findPaymentBySession`;
`payments_one_paid_per_kind (order_id, kind) where status='paid'` ⇢ doubles as the scan source for
`sumPaidPaymentsByOrg`'s `where p.status='paid'`; `orders_lifecycle_suspended_idx` ⇢
`listSuspendedBefore`; `deployed_services_order_service_idx` ⇢ the `on conflict` upsert;
`rate_limits_scope_key_idx`/`rate_limits_scope_idx` ⇢ both `countRateLimitHits` branches;
`users.email UNIQUE` and `users_github_id_key` ⇢ the two sign-in lookups;
`iteration_brief_org_idx` ⇢ the org-filtered brief list.

### Missing constraints the code assumes

- `resident_usage.month text not null` and `resident_usage_reports.month text not null` have **no
  CHECK on the `YYYY-MM` shape**, yet `month` is the grouping key for billing and the idempotency
  key component in `usageReportIdentifier` ([paymentService.ts:126](apps/api/src/services/paymentService.ts#L126)).
  A malformed month from `POST /internal/resident/usage` creates a permanently unbillable bucket.
- `resident_installations.id text primary key` — no length or format constraint. The code already
  works around unbounded length by hashing (`maxUsageIdentifierLength = 100`,
  [paymentService.ts:110](apps/api/src/services/paymentService.ts#L110)); a
  `check (length(id) between 1 and 200)` would remove the workaround's reason to exist.
- `orders.org_id` is `not null` but the code writes `''` as a sentinel — `upsertOrder` inserts
  `${draft.orgId ?? ''}` ([orders.ts:130](packages/db/src/orders.ts#L130)) and `listActiveOrgIds`
  filters `org_id <> ''`. Every org-scoped guard is `order.orgId !== session.orgId`
  ([orderService.ts:87](apps/api/src/services/orderService.ts#L87)), so `''` behaves as a real
  tenant that no session can ever match — safe today, but it is a sentinel enforced by convention
  rather than `check (org_id <> '')`.
- `deployed_services.config jsonb` stores, per migration `0016:13`, "the container env (generated
  JWT/VAPID secrets)" **in plaintext in the application database**, and it is read back verbatim by
  `resumeServices` ([accountService.ts:224](apps/api/src/services/accountService.ts#L224)). The
  column is correctly kept out of responses, but there is no encryption, no column-level grant, and
  no CHECK that it never round-trips to a customer schema. See **API-13**.

### Transactions and read-modify-write

**Correctly done** (recorded so they are not re-flagged): `upsertResidentUsage` wraps its
installation-create + usage-upsert in `sql.begin` ([resident.ts:140](packages/db/src/resident.ts#L140));
`insertUserWithOrg` wraps org+user in `sql.begin` ([users.ts:99](packages/db/src/users.ts#L99));
`migrate` takes `pg_advisory_xact_lock` inside its transaction ([migrate.ts:25](packages/db/src/migrate.ts#L25));
`reserveResidentUsageReport` is a genuinely elegant single-statement compare-and-set
([resident.ts:283](packages/db/src/resident.ts#L283)); `transitionOrder` and `setLifecycle` are CAS
over `from` sets; `markPaymentPaid` is CAS on `status = 'pending'`.

**Unprotected read-modify-write:** `jobService.reportEvents` (**API-09**), `applyPaidSession`
→ order transition → build start (**API-10**), `applyRecordEffects` → `setLifecycle`
(**API-11**). Details below.

### Unbounded reads

Every list query does carry a `LIMIT`, which is better than most codebases — but three of the limits
are silent truncation rather than pagination, because no caller can ever request page 2:

- `listEvents(jobId, afterId=0)` → `limit 500`, and `getDeliverables` reads the **first** 500 while
  the `bundle` event is always last (**API-02**).
- `listResidentUsage` → `limit 1000` with no cursor; a month with more days×installations silently
  drops rows from the admin view ([resident.ts:183](packages/db/src/resident.ts#L183)).
- `summarizeResidentUsage` → `limit 500` applied **after** `group by`, so the aggregate itself scans
  the whole table before the limit bites ([resident.ts:199](packages/db/src/resident.ts#L199)).
- `listOrders`/`listOrderRecords`/`listJobs` → `limit 200`, no offset/cursor. The portal's order list
  becomes wrong, not slow, at 201 orders ([orders.ts:108](packages/db/src/orders.ts#L108)).

### N+1

- `notifyAdmins` issues one `countEvents` query **per notify event in the batch**, inside the
  `for (const event of events)` loop at [jobService.ts:494](apps/api/src/services/jobService.ts#L494)
  → `notifyAdmins` at line 277. A 50-event batch with 10 notifies = 10 `count(*)` scans of that
  job's events. Hoist the count once per batch and increment locally.
- `reportView` calls `db.orders.getOrder(job.orderId)` **twice** for the same order —
  `customerGithubLoginOf` ([jobService.ts:258](apps/api/src/services/jobService.ts#L258)) and
  `approveBeforeDeliverOf` ([jobService.ts:266](apps/api/src/services/jobService.ts#L266)) — plus a
  third in `pricesForJob` on any usage-bearing update. The build container polls this view.

### Pool configuration

[packages/db/src/index.ts:103-119](packages/db/src/index.ts#L103):

```ts
const sql = postgres(connectionString, {
	max: options?.max ?? 5,
	ssl: sslOptions(sslMode(connectionString)),
	transform: { undefined: null },
	types: { bigint: postgres.BigInt },
	onnotice: () => {},
})
```

`grep -rn "statement_timeout|idle_timeout|connect_timeout|max_lifetime"` across `packages/db`,
`apps` and `infra/lib` returns **nothing**. See **API-07**. Connection cleanup on the error path is
otherwise correct: `plugins/db.ts:158` registers `app.addHook('onClose', () => db.close())`, and
`resolveConnectionString` destroys its `SecretsManagerClient` in a `finally`
([plugins/db.ts:51](apps/api/src/plugins/db.ts#L51)) — no leak found there.

### Model ⇄ schema drift

- `awaiting_approval` — in `packages/models/schemas/Order.ts:20`, not in the CHECK (**API-01**).
- `unavailableRepositories` in `plugins/db.ts:57-125` is missing 9 methods that exist on the real
  repositories (**API-12**) — a models/repository-contract drift the `as T` cast hides.
- `jobs.tokens_used integer` (`0001:43`) vs a 40 M-token L budget: fine now, but `budget_tokens` and
  `tokens_used` are `integer` (max 2.1 B) while `resident_usage.total_tokens` is `bigint`. Two token
  counters, two widths.
- `Job.costUsd` is `number` in the model but `numeric(12,4)` in the column, correctly re-parsed with
  `Number(row.cost_usd)` and an explicit `/** numeric arrives as a string */` comment
  ([jobs.ts:29](packages/db/src/jobs.ts#L29)). Good — the same care is *not* taken for
  `resident_usage`'s floats, which is API-03.

---

## High

### API-01 `orders.status` CHECK constraint has no `awaiting_approval` — the approval gate raises 23514 on Postgres

`packages/db/migrations/0004_orders_users_auth.sql:21`

```sql
alter table orders add constraint orders_status_check check (
	status in ('drafting', 'ready', 'frozen', 'deposit_paid', 'building', 'delivered', 'paid', 'cancelled')
);
```

No later migration alters it. But `apps/api/src/services/orderService.ts:127` writes exactly that
value:

```ts
const next: OrderStatus = order.approveBeforeDeliver ? 'awaiting_approval' : 'delivered'
return (await db.orders.transition(order.id, ['building'], next)) ?? order
```

and `packages/models/schemas/Order.ts:45-46` declares the transitions
(`building: ['awaiting_approval', ...]`, `awaiting_approval: ['delivered', 'cancelled']`).

Impact: on any order with `approve_before_deliver = true`, the first `getDetail` read after the job
delivers throws `23514 check_violation` out of `syncWithJob` — which is called on the *read* path
([orderService.ts:159](apps/api/src/services/orderService.ts#L159)), so the order page 500s
permanently, and `paymentService.checkout` (which calls `getDetail` first) can never take the
balance. Every test passes because the memory backend has no CHECK.
Fix: migration `0020` — `alter table orders drop constraint orders_status_check; alter table orders
add constraint orders_status_check check (status in (..., 'awaiting_approval'));` and add a
`packages/db/test/migrations.test.ts` case asserting every `OrderStatusSchema` value is insertable.

### API-02 `getDeliverables` reads the first 500 events but needs the last one

`apps/api/src/services/jobService.ts:454`

```ts
const deliverable = deliverableFromEvents(await db.jobs.listEvents(jobId))
```

`listEvents` defaults `afterId = 0` and is `order by id asc limit 500`
([packages/db/src/jobs.ts:281](packages/db/src/jobs.ts#L281)). `deliverableFromEvents` then scans
`events.toReversed()` for the final successful `bundle` delivery event
([jobService.ts:199](apps/api/src/services/jobService.ts#L199)) — which, being the last thing a job
emits, is outside the window for any job that logged more than 500 events. Result: a
successfully-delivered long job returns `EntityNotFound('deliverables', jobId)` forever, with no
error anywhere to explain it. Real jobs emit per-task, per-gate and per-delivery-step events, so 500
is reachable. Fix: add a `listEventsByType(jobId, 'delivery')` query (with the `(job_id, type)` index
from the table above) or select the last delivery event with `order by id desc limit 1`.

### API-03 Resident billing meters a summed `double precision`

`packages/db/migrations/0009_resident_usage.sql:26-27` stores `list_price_usd` and `billable_usd` as
`double precision`. `packages/db/src/resident.ts:206` sums them
(`sum(u.billable_usd) as billable_usd`), and `apps/api/src/services/paymentService.ts` line ~330
converts that float straight into the billed amount:

```ts
const totalUsdCents = usdCentsOf(summary.billableUsd)
```

A month is `count(*)` daily floats summed in binary FP, then rounded to cents — the reported total
can differ from the sum of the daily cents, and because the reserve/confirm ledger is *cumulative*
(`usd_cents = pending_usd_cents`), a drift of one cent in either direction is either permanently
under-billed or, if it drifts down, latched as `overreported` and routed to manual admin credit
([paymentService.ts:340](apps/api/src/services/paymentService.ts#L340)). Fix: `alter table
resident_usage alter column list_price_usd type numeric(12,4), alter column billable_usd type
numeric(12,4)` and map with `Number(...)` like `jobs.cost_usd` already does.

### API-04 Three foreign keys dropped for a type widening, never restored

`0002_jobs_task_arn.sql:5` (`jobs_order_id_fkey`), `0004_orders_users_auth.sql:11-12`
(`orders_org_id_fkey`, `orders_created_by_fkey`). The code treats all three as guaranteed
references. Worst case: `jobs.order_id` pointing at nothing means `pricesForJob`
([jobService.ts:249](apps/api/src/services/jobService.ts#L249)) silently falls back to *today's*
model prices for a job whose order was meant to lock in an older price sheet — the exact behaviour
migration `0018`'s header promises never happens ("a later price change never reprices an order
already placed"). Fix: re-add as `text` FKs — `alter table jobs add constraint jobs_order_id_fkey
foreign key (order_id) references orders(id) on delete cascade not valid;` then `validate
constraint` (two short locks instead of one long one).

### API-05 Migrations run at API boot, inside one transaction, with non-concurrent index builds

`apps/api/src/plugins/db.ts:169` runs `await migrate(db)` during plugin registration, and
`packages/db/src/migrate.ts:25` wraps every pending file in a single `sql.begin`. Three consequences
that compound: (a) `CREATE INDEX CONCURRENTLY` is impossible by construction; (b) one slow statement
holds the advisory lock and blocks *every other rolling task* from finishing boot; (c) an index build
on `job_events` or `rate_limits` blocks writes for its duration while the ALB is still routing
traffic. The failure handling is good — `decorateUnavailable` makes `/health` 503 rather than
silently degrading — but the blast radius of a slow migration is a full rollout stall. Fix: split the
runner so a migration file may opt out of the wrapping transaction (`-- @no-transaction` header), and
move the migration step out of the request-serving task into a one-shot ECS task or CDK custom
resource before the rollout.

### API-06 Liveness sweep seq-scans `jobs` on every tick

`packages/db/src/jobs.ts:184`

```sql
select * from jobs
where status in ${sql(activeJobStatus)} and task_arn is not null and created_at < ${olderThan}
order by created_at asc limit 200
```

No index on this table supports `status`, `task_arn` or a bare `created_at` (see the missing-index
table). `runJobSweep` calls it from a scheduled plugin
([apps/api/src/lib/jobSweep.ts:63](apps/api/src/lib/jobSweep.ts#L63)) on every task in the service,
so the scan cost multiplies by task count. Fix: the partial index named above; it is also the index
that will make the Gate C `task_arn IS NULL` fix cheap when that lands.

### API-07 No statement, idle, connect or lifetime timeout on the connection pool

`packages/db/src/index.ts:103-113` sets only `max: 5`. With no `statement_timeout`, a single query
that plans badly — and API-06's seq scan is the obvious candidate as `jobs` grows — pins one of five
connections indefinitely; five of them and the API stops serving while `/health` still reports 200
(the health check does not run a query through the pool). With no `connect_timeout`, a network
partition to RDS hangs `migrate()` at boot and the task never becomes healthy or unhealthy. With no
`idle_timeout`/`max_lifetime`, connections survive RDS failovers as half-open sockets. Fix:

```ts
max: options?.max ?? 5,
connect_timeout: 10,
idle_timeout: 30,
max_lifetime: 60 * 30,
connection: { statement_timeout: 15_000 },
```

with a longer per-call override for `migrate`.

### API-08 Every AWS SDK client and the Anthropic client are constructed with no timeout

| Client | Site |
|---|---|
| `new Anthropic({ apiKey: anthropicApiKey })` | [apps/api/src/plugins/anthropic.ts:37](apps/api/src/plugins/anthropic.ts#L37) |
| `new ECSClient({})` | [apps/api/src/plugins/ecs.ts:88](apps/api/src/plugins/ecs.ts#L88) |
| `new S3Client({})` | [apps/api/src/plugins/s3.ts:39](apps/api/src/plugins/s3.ts#L39) |
| `new SESv2Client({})` | [apps/api/src/plugins/email.ts:38](apps/api/src/plugins/email.ts#L38) |
| `new CloudWatchClient({})` | [apps/api/src/plugins/metrics.ts:30](apps/api/src/plugins/metrics.ts#L30) |
| `new OrganizationsClient({ region })` | [apps/api/src/plugins/org.ts:129](apps/api/src/plugins/org.ts#L129) |
| `new SecretsManagerClient({})` | [apps/api/src/plugins/db.ts:47](apps/api/src/plugins/db.ts#L47), [secrets.ts:198](apps/api/src/plugins/secrets.ts#L198), [stripe.ts:260](apps/api/src/plugins/stripe.ts#L260) |

None passes `requestHandler: new NodeHttpHandler({ connectionTimeout, requestTimeout })` or
`maxAttempts`. The Anthropic SDK's default timeout is 10 minutes — far past any ALB idle timeout, so
a hung spec-chat call burns a Fastify worker slot until the client gives up. The `SecretsManagerClient`
calls are on the **boot path** (`plugins/db.ts:49`, `secrets.ts`), so a hung Secrets Manager response
hangs startup with no upper bound.

Two call sites do this correctly and are the pattern to copy:
[plugins/stripe.ts:310](apps/api/src/plugins/stripe.ts#L310) (`timeout: 20_000`) and
[plugins/githubOAuth.ts:54](apps/api/src/plugins/githubOAuth.ts#L54)
(`signal: AbortSignal.timeout(githubRequestTimeoutMs)`, with the abort mapped to a typed
`GithubOAuthError` at line 58).

### API-09 `reportEvents` loses concurrent gate reports (unguarded read-modify-write)

`apps/api/src/services/jobService.ts:503-506`

```ts
if (gates.length) {
	const current = (await db.jobs.get(job.id))?.gates ?? []
	await db.jobs.update(job.id, { gates: [...current, ...gates] })
}
```

Read `jobs.gates`, append in JS, write the whole array back — no transaction, no CAS, no
`jsonb ||` server-side concatenation. The harness runs **five gates in parallel workers**, all
POSTing to `/internal/jobs/:id/events` against a multi-task API. Two batches that interleave between
the `get` and the `update` produce a `jobs.gates` array missing one gate — and the delivery decision
reads that array. The per-event idempotency (`appendEventOnce`) is careful and correct; this
aggregate write undoes that care. Fix: `update jobs set gates = coalesce(gates, '[]'::jsonb) ||
${sql.json(gates)}` in a single statement, or wrap in `sql.begin` with `select ... for update`.

---

## Medium

### API-10 Payment application is four statements with no transaction and a crash window

`apps/api/src/services/paymentService.ts:185-229` — `findPaymentBySession` → `markPaymentPaid` →
`getOrder` → `orderService.transition` → `startBuild`. Each step is individually defensive
(`markPaymentPaid` is CAS on `status='pending'`; a failed transition is logged not thrown at
line 220), but the whole sequence is not atomic and the *event id was already consumed* by
`recordPaymentEvent` at line 236. The `forgetPaymentEvent` compensation at line 258 only fires on a
thrown exception — a process kill (ECS rolling deploy, OOM, task drain) between `markPaymentPaid`
and `transition` leaves: payment `paid`, order still `frozen`, no build started, and Stripe's retry
deduped as `duplicate`. Recovery requires an admin. Fix: wrap payment-mark + order-transition in one
`sql.begin`, and move `startBuild` behind a durable outbox/queue rather than the same request.

### API-11 Lifecycle bookkeeping and the state flip are not atomic

`apps/api/src/services/accountService.ts:184-186`

```ts
await applyRecordEffects(orderId, mode, deprovision)
const updated = await db.orders.setLifecycle(orderId, [from], to)
```

`applyRecordEffects` runs `markSuspended`/`markTornDown`/N× `setArn`
([accountService.ts:236-256](apps/api/src/services/accountService.ts#L236)), then the lifecycle CAS
runs separately. A failure between them soft-deletes every `deployed_services` row for the order
while `orders.lifecycle` still says `active` — the grace-period sweep will never revisit it and
`resumeServices` will find nothing to replay ("delivery predates recording"), permanently. The
guard above it that refuses to advance on `summary.failed > 0` (line 178) shows the right instinct;
it just stops one statement short. Fix: `sql.begin` around both, or make `setLifecycle` the first
write and the record effects idempotent-retryable.

### API-12 `unavailableRepositories` is missing 9 methods; an `as T` cast hides it

`apps/api/src/plugins/db.ts:57-60`

```ts
const repository = <T extends object>(keys: (keyof T)[]) =>
	Object.fromEntries(keys.map(key => [key, reject])) as T
```

The `as T` asserts a complete repository from a hand-maintained key list, so TypeScript never checks
it. Comparing against `packages/db/src/repositories.ts`, the DB-unavailable stub omits:

- `orders`: `setApproveBeforeDeliver`, `setLifecycle`, `setCustomerSlug`, `listSuspendedBefore`,
  `listActiveOrgIds`, `sumPaidPaymentsByOrg`
- `resident`: `reserveUsageReport`, `confirmUsageReport`, `releaseUsageReport`

When the database is unavailable those calls are `undefined`, so the caller throws
`TypeError: db.orders.setLifecycle is not a function` instead of the intended
`DatabaseUnavailable`. That surfaces to the admin lifecycle route and the resident billing run as an
opaque 500 with a misleading message, exactly when an operator is trying to diagnose a database
outage. Fix: build the stub from a `Record<keyof OrdersRepository, true>` key map so a new method
fails to compile until it is listed — no cast.

### API-13 Generated app secrets stored plaintext in `deployed_services.config`

`packages/db/migrations/0016_deployed_services.sql:12-13` and `:26` — the column holds "the exact
create input so resume is a faithful replay; it holds the container env (generated JWT/VAPID
secrets)". Read back verbatim at
[apps/api/src/services/accountService.ts:224](apps/api/src/services/accountService.ts#L224). These
are the delivered customer app's runtime secrets, sitting unencrypted in the factory's own database,
recoverable by anything with a read on that table (including a future admin export endpoint that
does not know to redact `config`). Fix: store a Secrets Manager ARN in `config` instead of the
literal env, or encrypt the column with a KMS data key.

### API-14 `jobService.start` has three non-atomic side effects after the insert

`apps/api/src/services/jobService.ts:377-400`. Insert job → `setCustomerSlug` (best-effort, line
379) → `ecs.runJob` (line 389) → `update({ taskArn })`. A crash after `runJob` but before the
`taskArn` write leaves a Fargate task running against a job row with `task_arn IS NULL`, which the
liveness sweep explicitly skips (`and task_arn is not null`,
[jobs.ts:189](packages/db/src/jobs.ts#L189)) — an orphaned, budget-burning task nothing reaps.
The `task_arn IS NULL` blindness itself is already Gate C; **the new part is that the API creates
that state on a normal crash path**, so fixing the sweep alone will not close it. Fix: write a
`launching` marker before `runJob`, or reverse the order (reserve the ARN via a client token).

### API-15 A failed customer-account provision is fire-and-forget with no retry record

`apps/api/src/services/paymentService.ts:244`

```ts
accountService.provisionCustomerAccount(orgId).catch(error => {
	app.log.error({ err: error, orgId }, 'Deposit paid but the AWS account could not be provisioned')
})
```

The comment above it justifies not awaiting (account vending takes minutes) — that reasoning is
sound. What is missing is durability: the only record of the failure is a log line, and nothing
re-drives it. The build proceeds and reaches delivery expecting an account that may not exist. Fix:
persist a provisioning attempt row (or reuse `orgs.aws_account_id IS NULL` + a sweep like
`lifecycleSweep`) so a failed vend is retried automatically rather than by an admin who read the log.

### API-16 `deprovisionAll` uses `Promise.all` where a partial failure should stop the fan-out

`apps/api/src/services/accountService.ts:202`

```ts
const results = await Promise.all(
	tags.map(tag => org.deprovision({ customerSlug: tag, label }, mode, { dryRun }))
)
```

`Promise.all` rejects on the first throw and abandons the others *in flight* — for a `teardown` that
means some fences are half-deprovisioned with no result recorded for them, and the caller's careful
`summary.failed > 0` check (line 178) never runs because the exception bypasses it. The function's
own contract says `@mf/org deprovision` "NEVER throws on a per-resource action failure", but that
guarantee does not cover a client/network throw. Fix: `Promise.allSettled` and fold rejections into
`summary.failed` so the existing guard sees them.

### API-17 Order status can regress via `syncWithJob` on a read path

`apps/api/src/services/orderService.ts:124-129`. `getDetail` — a **GET** — performs a write. It is
CAS-guarded (`transition(order.id, ['building'], next)`) so it cannot corrupt state, but it means
order status advancement depends on someone opening the order page, GET is not idempotent, and the
`23514` of API-01 fires from a read. Fix: drive the transition from the job's terminal
`reportUpdate` (which already has the delivered status in hand,
[jobService.ts:527](apps/api/src/services/jobService.ts#L527)) and leave `getDetail` read-only.

### API-18 46 routes repeat `return reply.error(500, error as Error)`

The `as Error` cast appears in 24 route files (e.g.
[routes/bff/orders/createOrder.ts:24](apps/api/src/routes/bff/orders/createOrder.ts#L24),
[routes/internal/jobs/postJobToken.ts:27](apps/api/src/routes/internal/jobs/postJobToken.ts#L27),
[routes/bff/admin/margin/getRevenue.ts:24](apps/api/src/routes/bff/admin/margin/getRevenue.ts#L24)).
A thrown non-`Error` (a rejected string, a `DOMException` from an abort) is cast, then whatever
`reply.error` reads off it is `undefined`. More importantly this is 24 copies of a catch-all that
`plugins/errorHandling.ts` already provides — per `.claude/rules/api-routes.instructions.md`, route
handlers should let unexpected errors reach the error handler and only map the *expected* domain
errors. Fix: delete the trailing `catch`/`reply.error(500, ...)` from routes that add nothing, and
have `reply.error` accept `unknown`.

---

## Low

### API-19 `plugins/db.ts` has a duplicated JSDoc line

[apps/api/src/plugins/db.ts:18-19](apps/api/src/plugins/db.ts#L18) — the same sentence twice, once
ending "`auth`, `resident`)" and once "`auth`, `rateLimits`)". A merge artefact; neither list is
complete (`iterationBrief`, `deployedServices`, `modelPrices`, `pricingTiers` are missing from both).

### API-20 `completeFakeSession` swallows the real error to rewrite it

[apps/api/src/services/paymentService.ts:446](apps/api/src/services/paymentService.ts#L446)

```ts
await orderService.get(pending.orderId, session).catch(() => {
	throw new EntityNotFound('payment', sessionId)
})
```

Deliberate (the comment says "another org's session is as unknown as a missing one") and correct for
`EntityNotFound`, but it also converts a `DatabaseUnavailable` or a programming error into a 404.
Narrow it to `if (error instanceof EntityNotFound)` and rethrow otherwise.

### API-21 `notifyAdmins` awaits admin emails serially inside the event loop

[apps/api/src/services/jobService.ts:286](apps/api/src/services/jobService.ts#L286) —
`for (const to of app.secrets.authAdminEmails) await app.email.send(...)`, nested inside the
per-event loop at line 494. With SESv2 having no timeout (API-08), N admins × M notify events all
serialise on the build container's report request. `flagRefund` at
[paymentService.ts:173](apps/api/src/services/paymentService.ts#L173) does the same thing correctly
with `Promise.allSettled`; copy that.

### API-22 `countEvents`/`listEvents` return empty instead of erroring on a malformed id

[packages/db/src/jobs.ts:270](packages/db/src/jobs.ts#L270) and
[:281](packages/db/src/jobs.ts#L281) — `if (!isUuid(jobId)) return 0 / return []`. Intentional (the
comment on `isUuid` explains it prevents a `22P02`), but `appendEvent`/`appendEventOnce` have **no**
such guard, so a malformed id reads as empty and writes as `22P02` — two different behaviours for
the same bad input.

### API-23 `orders.messages` grows unbounded in a single jsonb column

`0004:31` (`add column messages jsonb not null default '[]'`) and `upsertOrder` rewrites the entire
array on every spec-chat turn ([orders.ts:130](packages/db/src/orders.ts#L130)). Every message send
is a full read-modify-write of the whole conversation plus a TOAST rewrite. Fine at demo length;
worth a `spec_messages` table before the spec engine sees real use.

---

## Test gaps

**The structural gap:** `apps/api/test/plugins/__mocks__/db.ts` swaps in
`createMemoryRepositories()` for every service and route test — 11 000 lines of tests, and the only
thing that ever executes `packages/db/migrations/*.sql` is `packages/db/test/migrations.test.ts`,
which is gated on `TEST_DATABASE_URL` and (per its own header) only checks that the files *apply*.
No test asserts that a query the code issues actually runs against the real schema. That is precisely
how API-01 (missing CHECK value) and API-04 (missing FKs) survived: the memory backend enforces
neither. The file's own comment describes the 0016 `uuid` vs `text` bug reaching a dev deploy the same
way — the fix closed the migration half of the hole and left the behaviour half open.

Specific gaps:

1. **No `packages/db/test/orders.test.ts`, `users.test.ts`, `auth.test.ts` or
   `deployedServices.test.ts`.** `packages/db/test/` has `jobs`, `resident`, `iterationBrief`,
   `modelPrices`, `pricingTiers`, `rateLimits`, `mapping`, `memory`, `migrations`, `ssl`, and
   `modelPriceMath` — the four highest-risk repositories (orders/payments, users/orgs, magic
   links/refresh tokens, deployed services) have no dedicated suite. `orders.ts` is 394 lines and
   owns every money-adjacent CAS.
2. **The whole `awaiting_approval` path is tested only against memory.** No test inserts
   `status = 'awaiting_approval'` into real Postgres. A single case in `migrations.test.ts` looping
   over `OrderStatusSchema.options` and inserting each would have caught API-01.
3. **`getDeliverables` has no test with >500 events** (API-02). `apps/api/test/services/jobService.test.ts`
   is 779 lines and covers deliverables, but only with short event lists — the bug is invisible below
   the limit.
4. **`reportEvents` has no concurrency test** (API-09). No test issues two overlapping gate batches
   and asserts both gates survive; the existing `appendEventOnce` duplicate tests cover the
   *per-event* idempotency that works, not the *aggregate* write that does not.
5. **Four routes have no test file at all:**
   `bff/admin/pricingTiers/postPricingTier`, `bff/admin/pricingTiers/getPricingTiers`,
   `bff/admin/modelPrices/getModelPrices`, `bff/admin/modelPrices/postModelPrice`. `postModelPrice`
   writes the table that determines every job's `cost_usd` — an unvalidated price row silently
   reprices margin reporting.
6. **`unavailableRepositories` completeness is untested** (API-12). `apps/api/test/plugins/db.test.ts`
   (140 lines) asserts the DB-unavailable path rejects, but only for methods that are *in* the list —
   the missing 9 are unreachable from the test. A test iterating `Object.keys` of a real repository
   and asserting each key exists on the stub would be ~6 lines and would fail today.
7. **No test asserts a timeout exists on any AWS client** (API-08). `apps/api/test/plugins/ecs.test.ts`
   (201 lines) and `s3`/`email` tests mock the SDK send, so client construction options are never
   observed.
8. **Pool configuration is untested.** `packages/db/test/ssl.test.ts` carefully asserts the `ssl`
   option matrix — the same style of test for `max`/`connect_timeout`/`statement_timeout` would lock
   API-07's fix in place.
9. **Assert-nothing risk:** `apps/api/test/legal/drafts.test.ts` (100 lines) checks markdown files
   exist/parse — legitimate, but it is 100 of the "1 175 tests green" that say nothing about the
   backend. Worth remembering when the test count is cited as evidence of coverage.

---

## Refactor candidates

| File | Lines | One-line split plan |
|---|---|---|
| [packages/db/src/memory.ts](packages/db/src/memory.ts) | 926 | Split per aggregate (`memory/orders.ts`, `memory/jobs.ts`, `memory/resident.ts`, `memory/auth.ts`) mirroring the Postgres modules 1:1, so a divergence like API-01/API-12 is visible as a missing file rather than buried in one blob. |
| [apps/api/src/services/jobService.ts](apps/api/src/services/jobService.ts) | 554 | Extract the `/internal` reporting half (`authenticateReport`, `rotateReportToken`, `reportView`, `reportEvents`, `reportUpdate` + the token helpers) into `jobReportService.ts`; leave the customer-facing CRUD (`start`, `get`, `listForOrder`, `kill`, `approve`, `getDeliverables`) in `jobService.ts`. |
| [apps/api/src/services/paymentService.ts](apps/api/src/services/paymentService.ts) | 472 | Move the resident metering block (`billInstallation`, `usageReportIdentifier`, `usageReportInFlightMs`, `maxUsageIdentifierLength`, ~180 lines) into `residentBillingService.ts` — it shares only `paymentProvider` with checkout/webhooks. |
| [packages/db/src/repositories.ts](packages/db/src/repositories.ts) | 433 | Split the interface file per aggregate alongside its implementation (`orders.types.ts`, `jobs.types.ts`, …) per `.claude/rules/api-services.instructions.md`'s `.types.ts` convention, and re-export from `repositories.ts` — this is also the enabler for the compile-checked stub in API-12. |
| [packages/db/src/orders.ts](packages/db/src/orders.ts) | 394 | Split into `orders.ts` (spec draft + order record + lifecycle) and `payments.ts` (`insertPayment`, `getPayment`, `findPaymentBySession`, `listPayments`, `markPaymentPaid`, `recordPaymentEvent`, `forgetPaymentEvent`, `sumPaidPaymentsByOrg`) — two aggregates, two tables, currently one `OrdersRepository`. |
