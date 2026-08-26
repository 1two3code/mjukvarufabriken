# Stream: m6-orders — order flow, Stripe, portal job/admin views (PLAN.md M6)

Areas: `apps/api` (`routes/bff/orders/*`, `routes/bff/admin/*`, `routes/bff/stripe/*`,
`services/orderService.ts`, `services/paymentService.ts`, `plugins/stripe.ts`), `apps/portal`
(all), `packages/models` (Order/Payment schemas), `packages/db` ONLY a new migration
`0006_orders_payments.sql` + `orders.ts` repository additions. Do not touch harness, job, site,
infra beyond `STRIPE_*` env plumbing in `web-stack.ts` if strictly needed.

## Context
Persistence (wave 1) moved orders/specs/users to Postgres via `app.db.*`. Jobs are started with
`POST /bff/orders/:orderId/jobs`; the portal has `/orders/:orderId/spec` and
`/orders/:orderId/job`. Stripe: Checkout, test mode; no keys exist yet (TODO-EXTERNAL), secrets
`stripe-secret-key` / `stripe-webhook-secret` are placeholders in Secrets Manager. Pricing:
fixed price per frozen spec (`priceSek`), 50 % deposit before build, 50 % on delivery.

## Deliverables
1. **Order model + state machine** (`packages/models/order.ts`, repository, service):
   draft → spec → frozen → deposit_paid → building → delivered → paid | cancelled, with the
   transitions enforced server-side; `POST /bff/orders` creates an order (name), `GET /bff/orders`
   lists the org's orders, `GET /bff/orders/:id` returns order + spec status + latest job summary
   + payment status.
2. **Stripe** behind `PaymentProvider` interface (`stripe` npm, `createCheckoutSession`,
   `constructWebhookEvent`) with a `fake` provider when `STRIPE_SECRET_KEY` is absent (returns a
   local URL that immediately marks the payment paid in dev — clearly labelled). Routes:
   `POST /bff/orders/:id/checkout` (kind deposit|balance → Checkout session URL, line item =
   50 % of `priceSek` incl. 25 % moms shown separately), `POST /bff/stripe/webhook` (raw body,
   signature verified, idempotent on event id, marks payment paid → order transition → for
   deposit: starts the job automatically via `jobService.start`). Invoices are Stripe-hosted:
   store `hostedInvoiceUrl`/`receiptUrl` from the session.
3. **Portal**: order list + "New order" (`/orders`), order page with a stepper (spec → freeze →
   deposit → build → delivery → balance), spec page unchanged, job page extended with the gate
   reports (from `jobs.gates`), deliverables (download links from `GET /bff/jobs/:id/deliverables`
   when present), token usage vs budget, and payment buttons that open Checkout. sv+en.
4. **Admin view** (`/admin`, admins only): all jobs across orgs (`GET /bff/admin/jobs` exists),
   status, tokens/budget, org, order, kill button, plus totals (jobs today, tokens today).
5. Tests for the state machine, checkout, webhook (fake provider + a signed-payload test using
   Stripe's test signing helper), routes; portal has no test setup — keep it that way.
6. PLAN.md M6: order flow / live progress / admin boxes ticked with "fake provider verified;
   Stripe test mode pending keys (TODO-EXTERNAL)".

## Verification
- `npm run lint`, `npm test`, `npm run build`, `npm run smoke`.
